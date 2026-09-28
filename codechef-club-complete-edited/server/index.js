import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD } from '../src/demoCredentials.js';

const scrypt = promisify(scryptCallback);
const root = fileURLToPath(new URL('../', import.meta.url));
const dataDir = join(root, 'data');
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, 'club.sqlite'));
db.exec(`PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
 password_hash TEXT NOT NULL, salt TEXT NOT NULL, college TEXT NOT NULL DEFAULT '',
 year TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'student',
 created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL, date TEXT NOT NULL,
 time TEXT NOT NULL, venue TEXT NOT NULL, description TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'Open', featured INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS registrations (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 registered_at TEXT NOT NULL, ticket_code TEXT, attendee_name TEXT, attendee_email TEXT,
 attendee_college TEXT, attendee_year TEXT, attendee_phone TEXT, UNIQUE(user_id,event_id)
);`);
const registrationColumns = new Set(db.prepare('PRAGMA table_info(registrations)').all().map(column => column.name));
for (const column of ['ticket_code','attendee_name','attendee_email','attendee_college','attendee_year','attendee_phone']) {
 if (!registrationColumns.has(column)) db.exec(`ALTER TABLE registrations ADD COLUMN ${column} TEXT`);
}
db.exec("UPDATE registrations SET ticket_code='CC-'||upper(substr(hex(randomblob(5)),1,10)) WHERE ticket_code IS NULL; CREATE UNIQUE INDEX IF NOT EXISTS registrations_ticket_code ON registrations(ticket_code);");
db.exec("DELETE FROM users WHERE role='attendee' AND id NOT IN (SELECT user_id FROM registrations);");

const seed = [
 ['e1','The 90-Minute Sprint','Coding Contest','2026-10-08','4:00 PM','Computing Lab · Block C','A friendly timed contest for all levels. Three problems, one leaderboard, and snacks after.','Open',1],
 ['e2','Git Without the Guesswork','Workshop','2026-10-14','3:30 PM','Seminar Room 2','Branch, merge, and collaborate without fear. Bring your laptop and a project idea.','Open',0],
 ['e3','Build Night: Campus Tools','Hackathon','2026-10-22','5:00 PM','Innovation Hub','Pair up and make one small thing that would make campus life better.','Open',0],
 ['e4','Inside the Interview Loop','Seminar','2026-09-10','2:00 PM','Auditorium B','A recent graduate shares a practical approach to technical interviews.','Closed',0],
 ['e5','Friday Problem Table','Meetup','2026-10-02','4:30 PM','Library Courtyard','Drop in, pick a problem, and work through it with the club.','Open',0],
];
const seedEvent = db.prepare('INSERT OR IGNORE INTO events (id,name,category,date,time,venue,description,status,featured) VALUES (?,?,?,?,?,?,?,?,?)');
for (const e of seed) seedEvent.run(...e);

const uid = () => randomBytes(16).toString('hex');
const hashToken = token => createHash('sha256').update(token).digest('hex');
const safeUser = user => ({ id:user.id,name:user.name,email:user.email,college:user.college,year:user.year,phone:user.phone,role:user.role });
const json = (res, status, value) => { const body=JSON.stringify(value);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store'});res.end(body); };
async function body(req){let raw='';for await(const part of req){raw+=part;if(raw.length>100_000)throw Object.assign(new Error('Request too large.'),{status:413});}try{return raw?JSON.parse(raw):{};}catch{throw Object.assign(new Error('Invalid JSON body.'),{status:400});}}
function eventRow(e){return {...e,featured:Boolean(e.featured)};}
function listEvents(){return db.prepare('SELECT * FROM events ORDER BY date ASC,time ASC').all().map(eventRow);}
async function currentUser(req){const header=req.headers.authorization||'';if(!header.startsWith('Bearer '))return null;const token=header.slice(7);const row=db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(hashToken(token),new Date().toISOString());return row||null;}
async function createSession(user){const token=randomBytes(32).toString('base64url');db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token),user.id,new Date(Date.now()+30*86400000).toISOString());return {token,user:safeUser(user)};}
function requireAdmin(user){if(!user||user.role!=='admin')throw Object.assign(new Error('Admin access required.'),{status:user?403:401});}
function validateEvent(x){for(const k of ['name','category','date','time','venue','description'])if(typeof x[k]!=='string'||!x[k].trim())throw Object.assign(new Error(`Please provide ${k}.`),{status:400});if(!/^\d{4}-\d{2}-\d{2}$/.test(x.date))throw Object.assign(new Error('Use a valid event date.'),{status:400});if(!['Open','Closed'].includes(x.status||'Open'))throw Object.assign(new Error('Invalid registration status.'),{status:400});}

const server=createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,'http://localhost');const path=url.pathname;const method=req.method;
  if(path.startsWith('/api/')){
   if(method==='GET'&&path==='/api/health')return json(res,200,{service:'codechef-campus-club',apiVersion:4,ok:true});
   if(method==='GET'&&path==='/api/events')return json(res,200,listEvents());
   if(method==='POST'&&path==='/api/auth/signup'){
    const x=await body(req);const name=String(x.name||'').trim(),email=String(x.email||'').trim().toLowerCase(),password=String(x.password||'');
    const college=String(x.college||'').trim(),year=String(x.year||''),phone=String(x.phone||'').trim();
    if(name.length<2||!/^\S+@\S+\.\S+$/.test(email)||password.length<8||college.length<2||!['1st year','2nd year','3rd year','4th year','Postgraduate'].includes(year)||!/^\+?[0-9\s()-]{10,15}$/.test(phone))throw Object.assign(new Error('Enter your name, valid email, password (8+ characters), college, year, and valid phone number.'),{status:400});
    const salt=randomBytes(16).toString('hex');const digest=await scrypt(password,salt,64);const user={id:uid(),name,email,password_hash:digest.toString('hex'),salt,college,year,phone,role:'student',created_at:new Date().toISOString()};
    try{db.prepare('INSERT INTO users (id,name,email,password_hash,salt,college,year,phone,role,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(user.id,user.name,user.email,user.password_hash,user.salt,user.college,user.year,user.phone,user.role,user.created_at);}catch{throw Object.assign(new Error('An account with this email already exists.'),{status:409});}
    return json(res,201,await createSession(user));
   }
   if(method==='POST'&&path==='/api/auth/login'){
    const x=await body(req);const email=String(x.email||'').trim().toLowerCase();const user=db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(email);if(!user||user.role!=='admin'||email!==DEMO_ADMIN_EMAIL)throw Object.assign(new Error('Email or password is incorrect.'),{status:401});const actual=Buffer.from(await scrypt(String(x.password||''),user.salt,64));const expected=Buffer.from(user.password_hash,'hex');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Object.assign(new Error('Email or password is incorrect.'),{status:401});return json(res,200,await createSession(user));
   }
   if(method==='POST'&&path==='/api/auth/admin-signup'){
    throw Object.assign(new Error('Admin account creation is disabled. Use the demo administrator login.'),{status:403});
   }
   const user=await currentUser(req);
   if(method==='GET'&&path==='/api/auth/me')return json(res,200,user?{user:safeUser(user)}:{user:null});
   if(method==='POST'&&path==='/api/auth/logout'){const token=(req.headers.authorization||'').replace(/^Bearer\s+/,'');if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(token));return json(res,200,{ok:true});}
   if(method==='POST'&&path==='/api/registrations'){
    const x=await body(req),name=String(x.name||'').trim(),email=String(x.email||'').trim().toLowerCase(),college=String(x.college||'').trim(),year=String(x.year||''),phone=String(x.phone||'').trim();
    if(name.length<2||!/^\S+@\S+\.\S+$/.test(email)||college.length<2||!['1st year','2nd year','3rd year','4th year','Postgraduate'].includes(year)||!/^\+?[0-9\s()-]{10,15}$/.test(phone))throw Object.assign(new Error('Enter your name, valid email, college, year, and phone number.'),{status:400});
    const event=db.prepare('SELECT * FROM events WHERE id=?').get(String(x.eventId||''));if(!event)throw Object.assign(new Error('This event could not be found.'),{status:404});if(event.status!=='Open')throw Object.assign(new Error('Registration is closed for this event.'),{status:409});
    const duplicate=db.prepare(`SELECT r.id FROM registrations r LEFT JOIN users u ON u.id=r.user_id WHERE r.event_id=? AND lower(COALESCE(r.attendee_email,u.email))=?`).get(event.id,email);
    if(duplicate)throw Object.assign(new Error('This email is already registered for this event.'),{status:409});
    const registrationId=uid(),registeredAt=new Date().toISOString(),ticketCode=`CC-${randomBytes(5).toString('hex').toUpperCase()}`,registrantId=uid(),guestEmail=`attendee-${registrantId}@local.invalid`;
    db.prepare("INSERT INTO users(id,name,email,password_hash,salt,role,created_at) VALUES(?,?,?,?,?,'attendee',?)").run(registrantId,name,guestEmail,randomBytes(48).toString('hex'),randomBytes(16).toString('hex'),registeredAt);
    try{db.prepare('INSERT INTO registrations(id,user_id,event_id,registered_at,ticket_code,attendee_name,attendee_email,attendee_college,attendee_year,attendee_phone) VALUES(?,?,?,?,?,?,?,?,?,?)').run(registrationId,registrantId,event.id,registeredAt,ticketCode,name,email,college,year,phone);}catch{db.prepare('DELETE FROM users WHERE id=?').run(registrantId);throw Object.assign(new Error('Could not save this registration. Please try again.'),{status:409});}
    return json(res,201,{ok:true,message:'Registration Successful!',ticket:{code:ticketCode,attendee:{name,email,college,year,phone},event:{name:event.name,category:event.category,date:event.date,time:event.time,venue:event.venue},registeredAt}});
   }
   if(method==='GET'&&path==='/api/registrations'){
    requireAdmin(user);const rows=db.prepare(`SELECT r.id,r.ticket_code AS ticketCode,r.registered_at AS registeredAt,u.id AS userId,COALESCE(r.attendee_name,u.name) AS name,COALESCE(r.attendee_email,u.email) AS email,COALESCE(r.attendee_college,u.college) AS college,COALESCE(r.attendee_year,u.year) AS year,COALESCE(r.attendee_phone,u.phone) AS phone,e.id AS eventId,e.name AS eventName FROM registrations r JOIN users u ON u.id=r.user_id JOIN events e ON e.id=r.event_id ORDER BY r.registered_at DESC`).all();return json(res,200,rows);
   }
   if(path==='/api/admin/events'){
    requireAdmin(user);
    if(method==='POST'){const x=await body(req);validateEvent(x);const id=uid();db.prepare('INSERT INTO events(id,name,category,date,time,venue,description,status,featured) VALUES(?,?,?,?,?,?,?,?,?)').run(id,x.name.trim(),x.category,x.date,x.time.trim(),x.venue.trim(),x.description.trim(),x.status||'Open',x.featured?1:0);return json(res,201,{...x,id});}
    if(method==='PUT'){const id=decodeURIComponent(url.searchParams.get('id')||'');const x=await body(req);validateEvent(x);const result=db.prepare('UPDATE events SET name=?,category=?,date=?,time=?,venue=?,description=?,status=?,featured=? WHERE id=?').run(x.name.trim(),x.category,x.date,x.time.trim(),x.venue.trim(),x.description.trim(),x.status||'Open',x.featured?1:0,id);if(!result.changes)throw Object.assign(new Error('Event not found.'),{status:404});return json(res,200,{...x,id});}
    if(method==='DELETE'){const id=decodeURIComponent(url.searchParams.get('id')||'');const result=db.prepare('DELETE FROM events WHERE id=?').run(id);if(!result.changes)throw Object.assign(new Error('Event not found.'),{status:404});return json(res,200,{ok:true});}
   }
   return json(res,404,{error:'API route not found.'});
  }
  const dist=join(root,'dist');let file=normalize(join(dist,path==='/'?'index.html':path));if(!file.startsWith(dist))file=join(dist,'index.html');if(!existsSync(file))file=join(dist,'index.html');const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});createReadStream(file).pipe(res);
 }catch(error){json(res,error.status||500,{error:error.status?error.message:'Server error. Check the server logs.'});if(!error.status)console.error(error);}
});

async function bootstrapAdmin(){const email=DEMO_ADMIN_EMAIL;db.prepare("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role='admin' AND email<>? COLLATE NOCASE)").run(email);db.prepare("UPDATE users SET role='student' WHERE role='admin' AND email<>? COLLATE NOCASE").run(email);const salt=randomBytes(16).toString('hex'),digest=await scrypt(DEMO_ADMIN_PASSWORD,salt,64),existing=db.prepare('SELECT id FROM users WHERE email=? COLLATE NOCASE').get(email);if(existing){db.prepare("UPDATE users SET name='Club Warden',password_hash=?,salt=?,role='admin' WHERE id=?").run(digest.toString('hex'),salt,existing.id);}else{db.prepare('INSERT INTO users(id,name,email,password_hash,salt,role,created_at) VALUES(?,?,?,?,?,?,?)').run(uid(),'Club Warden',email,digest.toString('hex'),salt,'admin',new Date().toISOString());}console.log(`Demo admin account ready for ${email}`);}
await bootstrapAdmin();
const port=Number(process.env.PORT||3001);server.listen(port,()=>console.log(`CodeChef Club server listening at http://localhost:${port}`));
