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

test('setup-relay shortcut bypasses the installed CLI fast path so the installer can run the latest CLI surface', async () => {
  const installShPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const installPs1Path = join(repoRoot, 'scripts', 'release', 'installers', 'install.ps1');
  const installSh = await readFile(installShPath, 'utf8');
  const installPs1 = await readFile(installPs1Path, 'utf8');

  assert.match(
    installSh,
    /SETUP_RELAY_SHORTCUT="0"/,
    'expected install.sh to track whether --setup-relay was used as the shortcut path',
  );
  assert.match(
    installSh,
    /--setup-relay\)[\s\S]*SETUP_RELAY_SHORTCUT="1"/,
    'expected install.sh to mark the setup-relay shortcut during argument parsing',
  );
  assert.match(
    installSh,
    /if \[\[ -n "\$\{INSTALLED_CLI_BIN\}" && ! \( "\$\{SETUP_RELAY_SHORTCUT\}" == "1" && "\$\{RUN_ACTION\}" == "setup-relay" \) \]\]; then/,
    'expected install.sh to bypass the installed CLI fast path for the setup-relay shortcut',
  );
  assert.match(
    installPs1,
    /if \(\$Run -and -not \$SetupRelay -and \(\$existing = Resolve-InstalledCliInvoker\)\) \{/,
    'expected install.ps1 to bypass the installed CLI fast path for the setup-relay shortcut',
  );
});
