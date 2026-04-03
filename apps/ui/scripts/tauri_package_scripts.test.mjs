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

test('apps/ui Tauri public dev config enables the global Tauri bridge API for MCP tooling', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = dirname(scriptsDir);

  const raw = await readFile(join(packageRoot, 'src-tauri', 'tauri.publicdev.conf.json'), 'utf-8');
  const config = JSON.parse(raw);

  assert.equal(config?.app?.withGlobalTauri, true);
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
