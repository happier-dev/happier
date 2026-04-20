import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.sh --run setup-relay applies the default relay install arguments without network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-run-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(installDir, 'cli', 'current'), { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  // Fail the test if the installer tries to fetch anything.
  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho \"curl should not run\" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  // Provide a fake installed CLI for the stable ring in the managed location.
  const cliPath = join(installDir, 'cli', 'current', 'happier');
  await writeFile(
    cliPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "--help" ]]; then
  cat <<'EOF'
happier relay
happier auth
happier daemon
EOF
  exit 0
fi
if [[ "$1" = "relay" && "$2" = "--help" ]]; then
  cat <<'EOF'
happier relay inspect-target [--json]
happier relay set <relay-url>
happier relay host <install|status|start|stop|restart|uninstall>
EOF
  exit 0
fi
if [[ "$1" = "relay" && "$2" = "host" && "$3" = "install" ]]; then
  shift 3
  if [[ " $* " != *" --mode user "* ]]; then
    echo "missing --mode user" >&2
    exit 23
  fi
  if [[ " $* " != *" --yes "* ]]; then
    echo "missing --yes" >&2
    exit 24
  fi
  if [[ " $* " != *" --channel stable "* ]]; then
    echo "missing --channel stable" >&2
    exit 25
  fi
  if [[ " $* " != *" --preserve-active-server "* ]]; then
    echo "missing --preserve-active-server" >&2
    exit 26
  fi
  echo "Relay host installed"
  echo "  http://localhost:53288"
  exit 0
fi
echo "unexpected args: $@" >&2
exit 22
`,
    'utf8',
  );
  await chmod(cliPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--run', 'setup-relay'], {
    env,
    encoding: 'utf8',
  });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `expected run to succeed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout, /Relay host installed/);
  assert.match(stdout, /http:\/\/localhost:53288/);

  await rm(root, { recursive: true, force: true });
});

test('install.sh --run setup-relay forwards relay host flags to the installed CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-setup-relay-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  const previewCliDir = join(installDir, 'cli-preview', 'current');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(previewCliDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho \"curl should not run\" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const cliPath = join(previewCliDir, 'happier');
  await writeFile(
    cliPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "--help" ]]; then
  cat <<'EOF'
happier relay
EOF
  exit 0
fi
if [[ "$1" = "relay" && "$2" = "--help" ]]; then
  cat <<'EOF'
happier relay inspect-target [--json]
happier relay set <relay-url>
happier relay host <install|status|start|stop|restart|uninstall>
EOF
  exit 0
fi
if [[ "$1" = "relay" && "$2" = "host" && "$3" = "install" ]]; then
  shift 3
  if [[ " $* " != *" --mode user "* ]]; then
    echo "missing --mode user" >&2
    exit 23
  fi
  if [[ " $* " != *" --yes "* ]]; then
    echo "missing --yes" >&2
    exit 24
  fi
  if [[ " $* " != *" --channel preview "* ]]; then
    echo "missing --channel preview" >&2
    exit 25
  fi
  if [[ " $* " != *" --preserve-active-server "* ]]; then
    echo "missing --preserve-active-server" >&2
    exit 26
  fi
  echo "ok"
  exit 0
fi
echo "unexpected args: $@" >&2
exit 22
`,
    'utf8',
  );
  await chmod(cliPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_CHANNEL: 'preview',
  };

  const res = spawnSync(
    'bash',
    [installerPath, '--run', 'setup-relay', '--', '--mode', 'user', '--yes', '--channel', 'preview', '--preserve-active-server'],
    { env, encoding: 'utf8' },
  );
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `expected run setup-relay to succeed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout, /ok/);

  await rm(root, { recursive: true, force: true });
});

test('install.sh --run auth-login runs the installed CLI without network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-auth-login-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(installDir, 'cli', 'current'), { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho \"curl should not run\" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const cliPath = join(installDir, 'cli', 'current', 'happier');
  await writeFile(
    cliPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "--help" ]]; then
  cat <<'EOF'
happier auth
EOF
  exit 0
fi
if [[ "$1" = "auth" && "$2" = "login" ]]; then
  shift 2
  echo "auth ok"
  echo "args=$*"
  exit 0
fi
echo "unexpected args: $@" >&2
exit 22
`,
    'utf8',
  );
  await chmod(cliPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
  };

  const res = spawnSync('bash', [installerPath, '--run', 'auth-login', '--', '--server-url', 'https://relay.example.test', '--persist'], {
    env,
    encoding: 'utf8',
  });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `expected auth-login to succeed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout, /auth ok/);
  assert.match(stdout, /--server-url https:\/\/relay\.example\.test/);
  assert.match(stdout, /--persist/);

  await rm(root, { recursive: true, force: true });
});

test('install.sh does not force noninteractive mode when running a post-install action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-noninteractive-env-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(installDir, 'cli', 'current'), { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho \"curl should not run\" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const cliPath = join(installDir, 'cli', 'current', 'happier');
  await writeFile(
    cliPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "--help" ]]; then
  cat <<'EOF'
happier setup
EOF
  exit 0
fi
if [[ "$1" = "setup" ]]; then
  if [[ -n "\${HAPPIER_NONINTERACTIVE:-}" ]]; then
    echo "HAPPIER_NONINTERACTIVE was forced: \${HAPPIER_NONINTERACTIVE}" >&2
    exit 25
  fi
  echo "ok"
  exit 0
fi
echo "unexpected args: $@" >&2
exit 22
`,
    'utf8',
  );
  await chmod(cliPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
  };
  delete env.HAPPIER_NONINTERACTIVE;

  const res = spawnSync('bash', [installerPath, '--run', 'setup'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `expected run to succeed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout, /ok/);

  await rm(root, { recursive: true, force: true });
});

test('install.sh --run setup-relay accepts a CLI that advertises relay support through relay --help', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-cli-setup-relay-guard-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');

  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(join(installDir, 'cli', 'current'), { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho \"curl should not run\" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  // CLI is present and can run the command, but the top-level `--help` output does not list relay.
  // The installer should still accept it if `relay --help` advertises the relay host surface.
  const cliPath = join(installDir, 'cli', 'current', 'happier');
  await writeFile(
    cliPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "--help" ]]; then
  cat <<'EOF'
happier auth
happier daemon
EOF
  exit 0
fi
if [[ "$1" = "relay" && "$2" = "--help" ]]; then
  cat <<'EOF'
happier relay inspect-target [--json]
happier relay set <relay-url>
happier relay host <install|status|start|stop|restart|uninstall>
EOF
  exit 0
fi
if [[ "$1" = "relay" && "$2" = "host" && "$3" = "install" ]]; then
  echo "relay invoked"
  exit 0
fi
echo "unexpected args: $@" >&2
exit 22
`,
    'utf8',
  );
  await chmod(cliPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    SHELL: '/bin/bash',
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync(
    'bash',
    [installerPath, '--run', 'setup-relay', '--', '--mode', 'user', '--yes', '--preserve-active-server'],
    { env, encoding: 'utf8' },
  );
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `expected run setup-relay to succeed when relay host help is advertised:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout, /relay invoked/);

  await rm(root, { recursive: true, force: true });
});
