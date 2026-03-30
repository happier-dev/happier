import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

test('dev Tauri config enables the MCP bridge without widening production capabilities', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const srcTauriDir = join(dirname(scriptsDir), 'src-tauri');

  const productionConfig = await readJson(join(srcTauriDir, 'tauri.conf.json'));
  const publicDevConfig = await readJson(join(srcTauriDir, 'tauri.publicdev.conf.json'));
  const mcpCapability = await readJson(join(srcTauriDir, 'capabilities', 'mcp-dev.json'));
  const cargoToml = await readFile(join(srcTauriDir, 'Cargo.toml'), 'utf8');
  const libSource = await readFile(join(srcTauriDir, 'src', 'lib.rs'), 'utf8');

  assert.deepEqual(productionConfig.app?.security?.capabilities ?? [], ['default']);
  assert.equal(publicDevConfig.app?.withGlobalTauri, true);
  assert.deepEqual(publicDevConfig.app?.security?.capabilities ?? [], ['default', 'mcp-dev']);
  assert.equal(mcpCapability.identifier, 'mcp-dev');
  assert.deepEqual(mcpCapability.windows ?? [], ['main']);
  assert.ok((mcpCapability.permissions ?? []).includes('mcp-bridge:default'));
  assert.match(cargoToml, /tauri-plugin-mcp-bridge/);
  assert.match(cargoToml, /tauri-plugin-mcp-bridge = "0\.10"/);
  assert.match(libSource, /cfg\(debug_assertions\)/);
  assert.match(libSource, /tauri_plugin_mcp_bridge::init\(\)/);
});
