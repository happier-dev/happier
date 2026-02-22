import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('self-host.sh --check uses existing hstack and does not fetch releases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-self-host-check-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo Linux
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo x86_64
  exit 0
fi
echo Linux
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  const systemctlStubPath = join(binDir, 'systemctl');
  await writeFile(systemctlStubPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(systemctlStubPath, 0o755);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho \"curl should not run in --check\" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const tracePath = join(root, 'trace.txt');
  const hstackStubPath = join(binDir, 'hstack');
  await writeFile(
    hstackStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> ${JSON.stringify(tracePath)}
if [[ "$1" = "self-host" && "$2" = "doctor" ]]; then
  exit 0
fi
exit 0
`,
    'utf8',
  );
  await chmod(hstackStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'self-host.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_HOME: join(homeDir, '.happier'),
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--check', '--mode', 'user', '--channel', 'preview'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `check failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);

  const trace = await readFile(tracePath, 'utf8').catch(() => '');
  assert.match(trace, /self-host status/i);
  assert.match(trace, /self-host doctor/i);

  await rm(root, { recursive: true, force: true });
});

test('self-host.sh --uninstall proxies to hstack self-host uninstall', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-self-host-uninstall-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo Linux
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo x86_64
  exit 0
fi
echo Linux
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  const systemctlStubPath = join(binDir, 'systemctl');
  await writeFile(systemctlStubPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(systemctlStubPath, 0o755);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho \"curl should not run in --uninstall\" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const tracePath = join(root, 'trace.txt');
  const hstackStubPath = join(binDir, 'hstack');
  await writeFile(
    hstackStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> ${JSON.stringify(tracePath)}
exit 0
`,
    'utf8',
  );
  await chmod(hstackStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'self-host.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_HOME: join(homeDir, '.happier'),
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--uninstall', '--purge-data', '--mode', 'user', '--channel', 'preview'], {
    env,
    encoding: 'utf8',
  });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `uninstall failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);

  const trace = await readFile(tracePath, 'utf8').catch(() => '');
  assert.match(trace, /self-host uninstall/i);
  assert.match(trace, /--purge-data/i);
  assert.match(trace, /--yes/i);

  await rm(root, { recursive: true, force: true });
});

test('self-host.sh --reset proxies to hstack self-host uninstall --purge-data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-self-host-reset-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo Linux
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo x86_64
  exit 0
fi
echo Linux
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  const systemctlStubPath = join(binDir, 'systemctl');
  await writeFile(systemctlStubPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(systemctlStubPath, 0o755);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho \"curl should not run in --reset\" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const tracePath = join(root, 'trace.txt');
  const hstackStubPath = join(binDir, 'hstack');
  await writeFile(
    hstackStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
echo "$*" >> ${JSON.stringify(tracePath)}
exit 0
`,
    'utf8',
  );
  await chmod(hstackStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'self-host.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_HOME: join(homeDir, '.happier'),
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--reset', '--mode', 'user', '--channel', 'preview'], { env, encoding: 'utf8' });
  assert.equal(res.status, 0, `reset failed:\n${String(res.stdout ?? '')}\n${String(res.stderr ?? '')}`);

  const trace = await readFile(tracePath, 'utf8').catch(() => '');
  assert.match(trace, /self-host uninstall/i);
  assert.match(trace, /--purge-data/i);
  assert.match(trace, /--yes/i);

  await rm(root, { recursive: true, force: true });
});

test('self-host.sh --restart restarts the service and uses existing hstack without network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-self-host-restart-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo Linux
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo x86_64
  exit 0
fi
echo Linux
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  const tracePath = join(root, 'trace.txt');

  const systemctlStubPath = join(binDir, 'systemctl');
  await writeFile(
    systemctlStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
echo "systemctl $*" >> ${JSON.stringify(tracePath)}
exit 0
`,
    'utf8',
  );
  await chmod(systemctlStubPath, 0o755);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho \"curl should not run in --restart\" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const hstackStubPath = join(binDir, 'hstack');
  await writeFile(
    hstackStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
echo "hstack $*" >> ${JSON.stringify(tracePath)}
exit 0
`,
    'utf8',
  );
  await chmod(hstackStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'self-host.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_HOME: join(homeDir, '.happier'),
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--restart', '--mode', 'user', '--channel', 'preview'], { env, encoding: 'utf8' });
  assert.equal(res.status, 0, `restart failed:\n${String(res.stdout ?? '')}\n${String(res.stderr ?? '')}`);

  const trace = await readFile(tracePath, 'utf8').catch(() => '');
  assert.match(trace, /systemctl --user restart happier-server\.service/i);
  assert.match(trace, /hstack self-host status/i);

  await rm(root, { recursive: true, force: true });
});

test('self-host.sh --reinstall is accepted and runs the install flow', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-self-host-reinstall-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo Linux
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo x86_64
  exit 0
fi
echo Linux
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  const systemctlStubPath = join(binDir, 'systemctl');
  await writeFile(systemctlStubPath, '#!/usr/bin/env bash\nexit 0\n', 'utf8');
  await chmod(systemctlStubPath, 0o755);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\necho \"curl invoked\" >&2\nexit 88\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'self-host.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_HOME: join(homeDir, '.happier'),
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--reinstall', '--mode', 'user', '--channel', 'preview'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 1, `expected reinstall to enter install flow and attempt fetching releases:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.doesNotMatch(stdout + stderr, /unknown argument/i);
  assert.match(stdout + stderr, /fetching .* release metadata/i);
  assert.match(stdout + stderr, /curl invoked/i);

  await rm(root, { recursive: true, force: true });
});

test('self-host.sh --version prints stack version without installing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-self-host-version-'));
  const homeDir = join(root, 'home');
  const binDir = join(root, 'bin');
  await mkdir(homeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  const unameStubPath = join(binDir, 'uname');
  await writeFile(
    unameStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" = "-s" ]]; then
  echo Darwin
  exit 0
fi
if [[ "$1" = "-m" ]]; then
  echo arm64
  exit 0
fi
echo Darwin
`,
    'utf8',
  );
  await chmod(unameStubPath, 0o755);

  const curlStubPath = join(binDir, 'curl');
  await writeFile(
    curlStubPath,
    `#!/usr/bin/env bash
set -euo pipefail
args="$*"
if [[ "$args" == *" -o "* ]]; then
  echo "curl should not download assets in --version" >&2
  exit 99
fi
cat <<'JSON'
{
  "assets": [
    { "name": "hstack-v1.2.3-darwin-arm64.tar.gz", "browser_download_url": "https://example.invalid/hstack-v1.2.3-darwin-arm64.tar.gz" }
  ]
}
JSON
exit 0
`,
    'utf8',
  );
  await chmod(curlStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'self-host.sh');
  const env = {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_HOME: join(homeDir, '.happier'),
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [installerPath, '--version', '--mode', 'user', '--channel', 'preview'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  assert.equal(res.status, 0, `version failed:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.match(stdout + stderr, /\b1\.2\.3\b/);
  assert.doesNotMatch(stdout + stderr, /Starting Happier Self-Host guided installation/i);

  await rm(root, { recursive: true, force: true });
});
