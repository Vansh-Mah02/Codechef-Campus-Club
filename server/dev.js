import { spawn } from 'node:child_process';
import { setTimeout as pause } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
let api;
let vite;
let stopping = false;
let apiExitCode = null;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (vite && !vite.killed) vite.kill();
  if (api && !api.killed) api.kill();
  process.exitCode = code;
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));

async function clubApiReady(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    const result = await response.json();
    return response.ok && result.service === 'codechef-campus-club' && result.apiVersion === 4;
  } catch { return false; }
}

async function portIsBusy(port) {
  try { await fetch(`http://127.0.0.1:${port}/api/health`); return true; }
  catch { return false; }
}

let apiPort = Number(process.env.PORT || 3001);
let ready = await clubApiReady(apiPort);
if (ready) console.log(`Using the club database server already running on port ${apiPort}.`);
else {
  if (await portIsBusy(apiPort)) {
    const requestedPort = apiPort;
    while (await portIsBusy(apiPort)) apiPort += 1;
    console.log(`Port ${requestedPort} is already in use; starting this club database on port ${apiPort}.`);
  }
  api = spawn(process.execPath, ['--env-file-if-exists=.env', 'server/index.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, PORT: String(apiPort) } });
  api.on('exit', (code) => {
    apiExitCode = code ?? 1;
    if (!stopping) {
      console.error('The club database server stopped. See the server message above.');
      stop(apiExitCode || 1);
    }
  });
  api.on('error', (error) => { console.error('Could not start the club database server:', error.message); stop(1); });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (apiExitCode !== null) break;
    ready = await clubApiReady(apiPort);
    if (ready) break;
    await pause(250);
  }
}

if (!ready || stopping) {
  console.error('The database server did not become ready. Check the server error above, then try npm run dev again.');
  stop(1);
} else {
  console.log('Club database is ready. Starting the website…');
  const viteEntry = join(root, 'node_modules', 'vite', 'bin', 'vite.js');
  vite = spawn(process.execPath, [viteEntry, '--host', '127.0.0.1'], { cwd: root, stdio: 'inherit', env: { ...process.env, CLUB_API_TARGET: `http://127.0.0.1:${apiPort}` } });
  vite.on('exit', (code) => stop(code ?? 0));
}
