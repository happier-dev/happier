import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('apps/ui package.json exposes shared stack-owned Tauri dev entrypoints', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const raw = await readFile(join(packageRoot, 'package.json'), 'utf-8');
  const pkg = JSON.parse(raw);
  const scripts = pkg?.scripts ?? {};

  assert.equal(scripts['tauri:dev'], 'node ../stack/scripts/tauri_dev.mjs');
  assert.equal(scripts['ui:tauri'], 'node ../stack/scripts/tauri_dev.mjs');
  assert.equal(scripts['tauri:qa'], 'node ./scripts/tauriMcpQa.mjs');
  assert.equal(scripts['tauri:mcp:server'], 'npx -y @hypothesi/tauri-mcp-server');
  assert.equal(scripts['tauri:mcp:cli'], 'npx -y -p @hypothesi/tauri-mcp-cli tauri-mcp');
  assert.equal(scripts['tauri:mcp:session:start'], 'npx -y -p @hypothesi/tauri-mcp-cli tauri-mcp driver-session start --port 9223');
});

test('apps/ui Tauri prepare scripts enable Expo Router web modal support', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const raw = await readFile(join(packageRoot, 'package.json'), 'utf-8');
  const pkg = JSON.parse(raw);
  const scripts = pkg?.scripts ?? {};

  assert.match(scripts['tauri:prepare:dev'], /EXPO_UNSTABLE_WEB_MODAL=1/);
  assert.match(scripts['tauri:prepare:build'], /EXPO_UNSTABLE_WEB_MODAL=1/);
});

test('apps/ui Expo update scripts enable Expo Router web modal support', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const raw = await readFile(join(packageRoot, 'package.json'), 'utf-8');
  const pkg = JSON.parse(raw);
  const scripts = pkg?.scripts ?? {};

  assert.match(scripts.ota, /EXPO_UNSTABLE_WEB_MODAL=1/);
  assert.match(scripts['ota:production'], /EXPO_UNSTABLE_WEB_MODAL=1/);
});

test('apps/ui Tauri public dev config enables the global Tauri bridge API for MCP tooling', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const raw = await readFile(join(packageRoot, 'src-tauri', 'tauri.publicdev.conf.json'), 'utf-8');
  const config = JSON.parse(raw);

  assert.equal(config?.app?.withGlobalTauri, true);
});

test('apps/ui Tauri channel configs use the expected desktop product names', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const stableRaw = await readFile(join(packageRoot, 'src-tauri', 'tauri.conf.json'), 'utf-8');
  const previewRaw = await readFile(join(packageRoot, 'src-tauri', 'tauri.preview.conf.json'), 'utf-8');
  const publicDevRaw = await readFile(join(packageRoot, 'src-tauri', 'tauri.publicdev.conf.json'), 'utf-8');

  const stable = JSON.parse(stableRaw);
  const preview = JSON.parse(previewRaw);
  const publicDev = JSON.parse(publicDevRaw);

  assert.equal(stable?.productName, 'Happier');
  assert.equal(stable?.app?.windows?.[0]?.title, 'Happier');

  assert.equal(preview?.productName, 'Happier (preview)');
  assert.equal(preview?.app?.windows?.[0]?.title, 'Happier (preview)');

  assert.equal(publicDev?.productName, 'Happier (dev)');
  assert.equal(publicDev?.app?.windows?.[0]?.title, 'Happier (dev)');

  // Linux installs executables and icons in shared directories. Distinct bundle
  // identifiers alone do not prevent channels (or the Happier CLI) colliding.
  const binaryNames = [stable, preview, publicDev].map((config) => config.mainBinaryName);
  for (const name of binaryNames) {
    assert.equal(typeof name, 'string');
    assert.match(name, /^[a-z][a-z0-9-]+$/);
    assert.notEqual(name, 'app');
    assert.notEqual(name, 'happier');
  }
  assert.equal(new Set(binaryNames).size, 3);
  assert.equal(stable.bundle.category, 'DeveloperTool');
  assert.ok(stable.bundle.publisher);
  assert.ok(stable.bundle.shortDescription);
  assert.ok(stable.bundle.longDescription);
});

test('apps/ui Tauri channel configs leave HTML5 file drag-and-drop available to the frontend', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  for (const configName of ['tauri.conf.json', 'tauri.preview.conf.json', 'tauri.publicdev.conf.json']) {
    const raw = await readFile(join(packageRoot, 'src-tauri', configName), 'utf-8');
    const config = JSON.parse(raw);
    const windows = Array.isArray(config?.app?.windows) ? config.app.windows : [];

    assert.ok(windows.length > 0, `${configName} should declare at least one Tauri window`);
    for (const windowConfig of windows) {
      assert.equal(windowConfig?.dragDropEnabled, false, `${configName} should let HTML5 file drag-and-drop reach the web frontend`);
    }
  }
});

test('apps/ui Tauri channel configs let the app create its main window, so a menu-bar login start loads no web UI', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  for (const configName of ['tauri.conf.json', 'tauri.preview.conf.json', 'tauri.publicdev.conf.json']) {
    const config = JSON.parse(await readFile(join(packageRoot, 'src-tauri', configName), 'utf-8'));
    const main = (config?.app?.windows ?? []).find((windowConfig) => windowConfig?.label === 'main');
    assert.ok(main, `${configName} should declare the main window by label`);
    // window_chrome::register creates it unless launched with --menu-bar (R16 b).
    assert.equal(main.create, false, `${configName} must not auto-create the main window`);
  }
});

test('apps/ui Tauri config runs beforeBuildCommand/beforeDevCommand via node wrapper (works on Windows CI)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const raw = await readFile(join(packageRoot, 'src-tauri', 'tauri.conf.json'), 'utf-8');
  const config = JSON.parse(raw);

  assert.equal(config?.build?.beforeDevCommand, 'node ./scripts/runTauriBeforeCommand.mjs tauri:prepare:dev');
  assert.equal(config?.build?.beforeBuildCommand, 'node ./scripts/runTauriBeforeCommand.mjs tauri:prepare:build');
});

test('apps/ui packages a native layered macOS app icon with a legacy fallback', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const srcTauriDir = join(packageRoot, 'src-tauri');

  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf-8'));
  const cliRange = packageJson?.dependencies?.['@tauri-apps/cli'];
  const cliVersion = typeof cliRange === 'string' ? cliRange.match(/(\d+)\.(\d+)/) : null;
  assert.ok(cliVersion, 'apps/ui should declare a parseable @tauri-apps/cli version');
  assert.ok(
    Number(cliVersion[1]) > 2 || (Number(cliVersion[1]) === 2 && Number(cliVersion[2]) >= 11),
    'Tauri CLI 2.11+ is required to compile Apple Icon Composer assets',
  );

  const config = JSON.parse(await readFile(join(srcTauriDir, 'tauri.conf.json'), 'utf-8'));
  const bundleIcons = Array.isArray(config?.bundle?.icon) ? config.bundle.icon : [];
  const iconComposerPath = bundleIcons.find((iconPath) => iconPath.endsWith('.icon'));
  assert.ok(iconComposerPath, 'the desktop bundle should include an Apple Icon Composer asset');
  assert.ok(
    bundleIcons.some((iconPath) => iconPath.endsWith('.icns')),
    'the desktop bundle should retain an ICNS fallback for pre-macOS 26 releases',
  );

  const iconRoot = join(srcTauriDir, iconComposerPath);
  const iconDocument = JSON.parse(await readFile(join(iconRoot, 'icon.json'), 'utf-8'));
  const referencedAssets = (iconDocument?.groups ?? [])
    .flatMap((group) => group?.layers ?? [])
    .flatMap((layer) => [
      layer?.['image-name'],
      ...(layer?.['image-name-specializations'] ?? []).map((entry) => entry?.value),
    ])
    .filter((assetName) => typeof assetName === 'string' && assetName !== 'automatic');

  assert.ok(referencedAssets.length > 0, 'the Icon Composer document should contain layered artwork');
  for (const assetName of new Set(referencedAssets)) {
    const asset = await readFile(join(iconRoot, 'Assets', assetName));
    assert.ok(asset.byteLength > 0, `Icon Composer artwork should exist: ${assetName}`);
  }
});

test('apps/ui default Tauri capability allows dialog open for SSH identity selection', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const raw = await readFile(join(packageRoot, 'src-tauri', 'capabilities', 'default.json'), 'utf-8');
  const capability = JSON.parse(raw);
  const permissions = Array.isArray(capability?.permissions) ? capability.permissions : [];

  assert.equal(permissions.includes('dialog:allow-open'), true);
  assert.equal(permissions.includes('core:window:allow-set-badge-count'), true);
  assert.equal(permissions.includes('core:window:allow-set-badge-label'), true);
});
