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

  assert.equal(scripts['typecheck'], 'node scripts/ensureWorkspacePackagesBuilt.mjs && tsc -p tsconfig.json --noEmit');
  assert.equal(scripts['tauri:dev'], 'yarn -s ensure:workspace:built && node ../stack/scripts/tauri_dev.mjs');
  assert.equal(scripts['ui:tauri'], 'yarn -s ensure:workspace:built && node ../stack/scripts/tauri_dev.mjs');
  assert.equal(scripts['tauri:qa'], 'yarn -s ensure:workspace:built && node ./scripts/tauriMcpQa.mjs');
  assert.equal(scripts['tauri:mcp:wizard:qa'], 'node ./scripts/qa/tauriOnboardingWizardMcpQa.mjs');
  assert.equal(scripts['tauri:mcp:activity-surfaces:qa'], 'node ./scripts/qa/tauriActivitySurfacesMcpQa.mjs');
  assert.equal(scripts['tauri:mcp:desktop-sidebar-chrome:qa'], 'node ./scripts/qa/tauriDesktopSidebarChromeMcpQa.mjs');
  assert.equal(scripts['test:native-e2e:activity-surfaces'], 'yarn -s ensure:workspace:built && node ./scripts/tauriMcpQa.mjs --activity-surfaces');
  assert.equal(scripts['test:native-e2e:desktop-sidebar-chrome'], 'yarn -s ensure:workspace:built && node ./scripts/tauriMcpQa.mjs --desktop-sidebar-chrome');
  assert.equal(scripts['tauri:mcp:server'], 'npx -y @hypothesi/tauri-mcp-server');
  assert.equal(scripts['tauri:mcp:cli'], 'npx -y -p @hypothesi/tauri-mcp-cli tauri-mcp');
  assert.equal(scripts['tauri:mcp:session:start'], 'npx -y -p @hypothesi/tauri-mcp-cli tauri-mcp driver-session start --port 9225');
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

test('apps/ui Tauri config runs beforeBuildCommand/beforeDevCommand via node wrapper (works on Windows CI)', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const raw = await readFile(join(packageRoot, 'src-tauri', 'tauri.conf.json'), 'utf-8');
  const config = JSON.parse(raw);

  assert.equal(config?.build?.beforeDevCommand, 'node ./scripts/runTauriBeforeCommand.mjs tauri:prepare:dev');
  assert.equal(config?.build?.beforeBuildCommand, 'node ./scripts/runTauriBeforeCommand.mjs tauri:prepare:build');
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

test('apps/ui pins tauri plugin-http to one exact version across package, Cargo.toml, and Cargo.lock', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf-8'));
  const cargoToml = await readFile(join(packageRoot, 'src-tauri', 'Cargo.toml'), 'utf-8');
  const cargoLock = await readFile(join(packageRoot, 'src-tauri', 'Cargo.lock'), 'utf-8');

  const jsVersion = packageJson?.dependencies?.['@tauri-apps/plugin-http'];
  const cargoTomlVersion = cargoToml.match(/tauri-plugin-http = "([^"]+)"/)?.[1];
  const cargoLockVersion = cargoLock.match(/name = "tauri-plugin-http"\nversion = "([^"]+)"/)?.[1];

  assert.equal(typeof jsVersion, 'string');
  assert.equal(jsVersion.startsWith('^'), false);
  assert.equal(jsVersion.startsWith('~'), false);
  assert.equal(cargoTomlVersion, `=${jsVersion}`);
  assert.equal(jsVersion, cargoLockVersion);
});

test('apps/ui default Tauri capability uses URL patterns that match loopback and arbitrary ports', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const capability = JSON.parse(await readFile(join(packageRoot, 'src-tauri', 'capabilities', 'default.json'), 'utf-8'));
  const permissions = Array.isArray(capability?.permissions) ? capability.permissions : [];
  const httpPermission = permissions.find((permission) => permission?.identifier === 'http:default');

  assert.ok(httpPermission);
  const allowUrls = Array.isArray(httpPermission.allow)
    ? httpPermission.allow.map((entry) => entry?.url).filter((value) => typeof value === 'string')
    : [];

  assert.equal(allowUrls.includes('http://**'), false);
  assert.equal(allowUrls.includes('https://**'), false);
  assert.equal(allowUrls.includes('http://*'), true);
  assert.equal(allowUrls.includes('http://*:*'), true);
  assert.equal(allowUrls.includes('https://*'), true);
  assert.equal(allowUrls.includes('https://*:*'), true);
});
