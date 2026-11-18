import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import plist from 'plist';
import { tmpdir } from 'node:os';
import { prepareTauriEntitlements } from './prepareTauriEntitlements.mjs';
import { buildStackTauriDevConfig } from '../../stack/scripts/utils/tauri/dev_runtime.mjs';

test('native tray, menu-bar and quit contracts pass through the real Rust owners', async () => {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  await promisify(execFile)('cargo', [
    'test', '--manifest-path', 'src-tauri/tests/menu_bar_harness/Cargo.toml', '--locked',
  ], { cwd: packageRoot });
});

test('every desktop channel leaves main webview creation to the native launch lifecycle', async () => {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  for (const channel of ['tauri.conf.json', 'tauri.preview.conf.json', 'tauri.publicdev.conf.json']) {
    const config = JSON.parse(await readFile(join(packageRoot, 'src-tauri', channel), 'utf-8'));
    assert.equal(config.app.windows[0].create, false, `${channel}: login must load no web UI`);
    assert.equal(config.app.windows[0].visible, false, `${channel}: rebuild hidden until menu-bar mode is left`);
    assert.equal(config.app.windows[0].label, 'main', channel);
  }
});

test('apps/ui package.json exposes shared stack-owned Tauri dev entrypoints', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const raw = await readFile(join(packageRoot, 'package.json'), 'utf-8');
  const pkg = JSON.parse(raw);
  const scripts = pkg?.scripts ?? {};

  assert.equal(scripts['typecheck'], '../stack/bin/hstack-exec --script=typecheck:local');
  assert.equal(scripts['typecheck:local'], 'node ../../scripts/workspaces/runTypeScriptCli.mjs -p tsconfig.json --noEmit');
  assert.equal(scripts['tauri:dev'], 'pnpm --silent run ensure:workspace:built && node ../stack/scripts/tauri_dev.mjs');
  assert.equal(scripts['ui:tauri'], 'pnpm --silent run ensure:workspace:built && node ../stack/scripts/tauri_dev.mjs');
  assert.equal(scripts['tauri:qa'], 'pnpm --silent run ensure:workspace:built && node ./scripts/tauriMcpQa.mjs');
  assert.equal(scripts['tauri:mcp:wizard:qa'], 'node ./scripts/qa/tauriOnboardingWizardMcpQa.mjs');
  assert.equal(scripts['tauri:mcp:activity-surfaces:qa'], 'node ./scripts/qa/tauriActivitySurfacesMcpQa.mjs');
  assert.equal(scripts['tauri:mcp:desktop-sidebar-chrome:qa'], 'node ./scripts/qa/tauriDesktopSidebarChromeMcpQa.mjs');
  assert.equal(scripts['test:native-e2e:activity-surfaces'], 'pnpm --silent run ensure:workspace:built && node ./scripts/tauriMcpQa.mjs --activity-surfaces');
  assert.equal(scripts['test:native-e2e:desktop-sidebar-chrome'], 'pnpm --silent run ensure:workspace:built && node ./scripts/tauriMcpQa.mjs --desktop-sidebar-chrome');
  // The Personal Home journey has no caller-attested completion mode: every gate it names is
  // proven from the loaded app and real runtime facts, so it fails rather than downgrading.
  assert.equal(scripts['test:native-e2e:personal-home'], 'pnpm --silent run ensure:workspace:built && node ./scripts/tauriMcpQa.mjs --personal-home');
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

test('apps/ui macOS Tauri bundles declare camera and microphone privacy and hardened-runtime access', async (t) => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);
  const srcTauriDir = join(packageRoot, 'src-tauri');

  const config = JSON.parse(await readFile(join(srcTauriDir, 'tauri.conf.json'), 'utf-8'));
  const infoPlist = plist.parse(await readFile(join(srcTauriDir, 'Info.plist'), 'utf-8'));
  const entitlements = plist.parse(await readFile(join(srcTauriDir, 'Entitlements.plist'), 'utf-8'));
  const scratch = await mkdtemp(join(tmpdir(), 'tauri-entitlements-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const generatedPath = join(scratch, 'Entitlements.plist');
  await prepareTauriEntitlements({ outputPath: generatedPath });
  const generated = await readFile(generatedPath, 'utf8');
  assert.equal(await readFile(join(srcTauriDir, 'Entitlements.plist'), 'utf8'), generated);
  const runtime = plist.parse(await readFile(
    new URL('../../../scripts/pipeline/release/bun-standalone.entitlements.plist', import.meta.url),
    'utf8',
  ));
  assert.deepEqual(entitlements, {
    ...runtime,
    'com.apple.security.device.audio-input': true,
    'com.apple.security.device.camera': true,
  });

  for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription']) {
    assert.equal(typeof infoPlist[key], 'string', key);
    assert.ok(infoPlist[key].trim().length > 0, key);
  }

  // Channel overlays and the stack dev merger must retain the shared macOS
  // declarations; Tauri automatically merges src-tauri/Info.plist into the app.
  for (const channel of ['tauri.conf.json', 'tauri.preview.conf.json', 'tauri.publicdev.conf.json']) {
    const overlayConfig = JSON.parse(await readFile(join(srcTauriDir, channel), 'utf8'));
    const effectiveConfig = buildStackTauriDevConfig({
      baseConfig: config,
      overlayConfig,
      env: { HAPPIER_STACK_STACK: 'camera-contract' },
    });
    assert.equal(effectiveConfig?.bundle?.macOS?.hardenedRuntime, true, channel);
    assert.equal(effectiveConfig?.bundle?.macOS?.entitlements, './Entitlements.plist', channel);
    assert.equal(Object.hasOwn(effectiveConfig?.bundle?.macOS ?? {}, 'infoPlist'), false, channel);
  }
});

test('macOS desktop admits HTTP localhost Homes without disabling ATS for other domains', async () => {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const info = plist.parse(await readFile(join(packageRoot, 'src-tauri', 'Info.plist'), 'utf8'));
  // AMD-9 permits localhost and its subdomains. A global local-network or WebView
  // exception would also admit unrelated HTTP Homes, beyond that contract.
  assert.deepEqual(info.NSAppTransportSecurity, {
    NSExceptionDomains: {
      localhost: {
        NSIncludesSubdomains: true,
        NSExceptionAllowsInsecureHTTPLoads: true,
      },
    },
  });
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
