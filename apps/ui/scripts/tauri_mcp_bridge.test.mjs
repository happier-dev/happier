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
  const cargoToml = await readFile(join(srcTauriDir, 'Cargo.toml'), 'utf8');
  const libSource = await readFile(join(srcTauriDir, 'src', 'lib.rs'), 'utf8');
  const mcpBridgeSource = await readFile(join(srcTauriDir, 'src', 'mcp_bridge.rs'), 'utf8');

  const productionCapabilities = productionConfig.app?.security?.capabilities ?? [];
  assert.deepEqual(productionCapabilities, ['default', 'overlay', 'pet_overlay']);
  assert.equal(publicDevConfig.app?.withGlobalTauri, true);
  assert.deepEqual(publicDevConfig.app?.security?.capabilities ?? [], [...productionCapabilities, 'mcp-dev']);
  assert.match(cargoToml, /tauri-plugin-mcp-bridge/);
  assert.match(cargoToml, /tauri-plugin-mcp-bridge = "0\.10"/);
  assert.match(libSource, /cfg\(debug_assertions\)/);
  assert.match(libSource, /mcp_bridge::build_debug_mcp_bridge_plugin\(\)/);
  assert.match(mcpBridgeSource, /McpBridgeBuilder::new\(\)\.bind_address\(&bind_address\)\.build\(\)/);
});
