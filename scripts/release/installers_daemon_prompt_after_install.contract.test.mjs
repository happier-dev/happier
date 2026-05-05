import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.sh resolves the background-service choice only after the CLI payload and shim are installed', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const source = await readFile(path, 'utf8');

  const appendPathHintIndex = source.indexOf('append_path_hint');
  const preflightIndex = source.indexOf('read_background_service_preflight_json "${DISPLAY_SHIM_PATH}"');
  const withDaemonIndex = source.indexOf('WITH_DAEMON="$(resolve_with_daemon_choice');

  assert.notEqual(appendPathHintIndex, -1, 'expected append_path_hint call');
  assert.notEqual(preflightIndex, -1, 'expected installer service preflight');
  assert.notEqual(withDaemonIndex, -1, 'expected WITH_DAEMON resolution');
  assert.ok(preflightIndex > appendPathHintIndex, 'expected service preflight after install-side effects');
  assert.ok(withDaemonIndex > preflightIndex, 'expected background-service choice after inventory preflight');
  assert.ok(withDaemonIndex > appendPathHintIndex, 'expected background-service prompt resolution after install-side effects');
});
