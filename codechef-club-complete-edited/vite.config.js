import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', proxy: { '/api': { target: process.env.CLUB_API_TARGET || `http://127.0.0.1:${process.env.PORT || 3001}`, changeOrigin: true } } },
});
