// @ts-check

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';

import { observeTauriStartup } from './linux-appimage-smoke-process.mjs';

function fail(message) { throw new Error(`[linux-appimage-wayland-smoke] ${message}`); }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const { values } = parseArgs({ options: { appimage: { type: 'string' }, duration: { type: 'string', default: '8' } }, allowPositionals: false });
  const appImage = path.resolve(String(values.appimage ?? '').trim());
  if (!appImage || !fs.existsSync(appImage)) fail(`missing AppImage: ${appImage || '<empty>'}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-wayland-smoke-'));
  const runtimeDir = path.join(root, 'runtime');
  fs.mkdirSync(runtimeDir, { mode: 0o700 });
  const socket = 'happier-wayland';
  const marker = path.join(root, 'startup-ready.json');
  let weston;
  let app;
  try {
    execFileSync(appImage, ['--appimage-extract'], { cwd: root, env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: '1' }, stdio: 'pipe', timeout: 120_000 });
    const appDir = path.join(root, 'squashfs-root');
    const hook = path.join(appDir, 'apprun-hooks', 'linuxdeploy-plugin-gtk.sh');
    if (fs.existsSync(hook)) {
      fs.writeFileSync(hook, fs.readFileSync(hook, 'utf8').replace('export GDK_BACKEND=x11', 'export GDK_BACKEND="${GDK_BACKEND:-x11}"'));
    }
    weston = spawn('weston', ['--backend=headless-backend.so', `--socket=${socket}`, '--idle-time=0'], {
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir }, stdio: 'ignore',
    });
    const socketPath = path.join(runtimeDir, socket);
    for (let i = 0; i < 50 && !fs.existsSync(socketPath); i += 1) await sleep(100);
    if (!fs.existsSync(socketPath)) fail('Weston did not create a Wayland socket');
    app = spawn(path.join(appDir, 'AppRun'), ['--appimage-extract-and-run'], {
      cwd: appDir,
      env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir, WAYLAND_DISPLAY: socket, XDG_SESSION_TYPE: 'wayland', GDK_BACKEND: 'wayland', LIBGL_ALWAYS_SOFTWARE: '1', MESA_LOADER_DRIVER_OVERRIDE: 'llvmpipe', HAPPIER_TAURI_STARTUP_MARKER: marker },
      stdio: 'inherit',
    });
    const durationMs = Math.max(3, Number(values.duration)) * 1000;
    await observeTauriStartup({ app, marker, durationMs, exitDescription: 'AppImage exited during native Wayland startup' });
    console.log(`[linux-appimage-wayland-smoke] passed: remained alive for ${durationMs / 1000}s`);
  } finally {
    if (app && app.exitCode === null) app.kill('SIGTERM');
    if (weston && weston.exitCode === null) weston.kill('SIGTERM');
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });
