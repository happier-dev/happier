import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('desktop Tauri wiring enables tray support and autostart registration', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const srcTauriDir = join(packageRoot, 'src-tauri');

  const cargoToml = await readFile(join(srcTauriDir, 'Cargo.toml'), 'utf8');
  const libSource = await readFile(join(srcTauriDir, 'src', 'lib.rs'), 'utf8');
  const traySource = await readFile(join(srcTauriDir, 'src', 'tray.rs'), 'utf8');
  const autostartSource = await readFile(join(srcTauriDir, 'src', 'autostart.rs'), 'utf8');

  assert.match(cargoToml, /tauri = \{ version = "2\.8\.2", features = \[[^\]]*"tray-icon"/);
  assert.match(cargoToml, /tauri-plugin-autostart = "2"/);

  assert.match(libSource, /mod autostart;/);
  assert.match(libSource, /mod tray;/);
  assert.match(libSource, /autostart::register\(app\)\?/);
  assert.match(libSource, /tray::register\(app\)\?/);
  assert.match(libSource, /autostart::desktop_get_autostart_enabled/);
  assert.match(libSource, /autostart::desktop_set_autostart_enabled/);
  assert.match(libSource, /tray::desktop_set_tray_state/);

  assert.match(autostartSource, /MacosLauncher::LaunchAgent/);
  assert.match(autostartSource, /tauri_plugin_autostart::init/);
  assert.match(autostartSource, /desktop_get_autostart_enabled/);
  assert.match(autostartSource, /desktop_set_autostart_enabled/);

  assert.match(traySource, /TrayIconBuilder/);
  assert.match(traySource, /MenuBuilder/);
  assert.match(traySource, /desktop_set_tray_state/);
  assert.match(traySource, /"tray-show-main-window"/);
  assert.match(traySource, /"tray-quit-app"/);
});
