// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

function fail(message) { throw new Error(`[linux-appimage-smoke] ${message}`); }

async function main() {
  const { values } = parseArgs({ options: { appimage: { type: 'string' }, duration: { type: 'string', default: '8' } }, allowPositionals: false });
  const appImage = path.resolve(String(values.appimage ?? '').trim());
  if (!appImage || !fs.existsSync(appImage)) fail(`missing AppImage: ${appImage || '<empty>'}`);
  const durationMs = Math.max(3, Number(values.duration)) * 1000;
  const marker = path.join(fs.mkdtempSync(path.join('/tmp', 'happier-startup-marker-')), 'ready.json');
  const display = `:${100 + (process.pid % 800)}`;
  const xvfb = spawn('Xvfb', [display, '-screen', '0', '1920x1080x24', '-ac'], { stdio: 'ignore' });
  let app;
  const cleanup = () => { if (app && app.exitCode === null) app.kill('SIGTERM'); if (xvfb.exitCode === null) xvfb.kill('SIGTERM'); };
  try {
    for (let i = 0; i < 50 && !fs.existsSync(`/tmp/.X11-unix/X${display.slice(1)}`); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    if (!fs.existsSync(`/tmp/.X11-unix/X${display.slice(1)}`)) fail('Xvfb did not create an X11 socket');
    app = spawn(appImage, ['--appimage-extract-and-run'], {
      env: { ...process.env, DISPLAY: display, GDK_BACKEND: 'x11', LIBGL_ALWAYS_SOFTWARE: '1', APPIMAGE_EXTRACT_AND_RUN: '1', HAPPIER_TAURI_STARTUP_MARKER: marker },
      stdio: 'inherit',
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, durationMs);
      app.once('error', reject);
      app.once('exit', (code, signal) => reject(new Error(`AppImage exited during startup with code=${code} signal=${signal}`)));
    });
    if (!fs.existsSync(marker) || JSON.parse(fs.readFileSync(marker, 'utf8')).phase !== 'ready') fail('Tauri startup-ready event was not observed');
    console.log(`[linux-appimage-smoke] passed: remained alive for ${durationMs / 1000}s`);
  } finally { cleanup(); fs.rmSync(path.dirname(marker), { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
