import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.sh resolves the daemon choice only after the already-installed --run fast path', async () => {
  const path = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const source = await readFile(path, 'utf8');

  const runFastPathIndex = source.indexOf('if [[ -n "${RUN_ACTION}" ]]; then');
  const invokeInstalledCliIndex = source.indexOf('run_post_install_action "${INSTALLED_CLI_BIN}"');
  const withDaemonIndex = source.indexOf('WITH_DAEMON="$(resolve_with_daemon_choice "${services_json}")"');

  assert.notEqual(runFastPathIndex, -1, 'expected --run fast path block');
  assert.notEqual(invokeInstalledCliIndex, -1, 'expected installed CLI fast path');
  assert.notEqual(withDaemonIndex, -1, 'expected WITH_DAEMON resolution');
  assert.ok(withDaemonIndex > invokeInstalledCliIndex, 'expected WITH_DAEMON resolution after the installed CLI fast path');
});
