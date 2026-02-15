import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('self-host.sh reaches release fetch on Linux without bash [[ ]] errors', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-self-host-runtime-'));
  const binDir = join(root, 'bin');
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

  // Force the script to hit the "No preview releases found" branch (after platform checks).
  const curlStubPath = join(binDir, 'curl');
  await writeFile(curlStubPath, '#!/usr/bin/env bash\nexit 22\n', 'utf8');
  await chmod(curlStubPath, 0o755);

  const selfHostPath = join(repoRoot, 'scripts', 'release', 'installers', 'self-host.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HAPPIER_CHANNEL: 'preview',
    HAPPIER_NONINTERACTIVE: '1',
  };

  const res = spawnSync('bash', [selfHostPath, '--mode', 'user', '--channel', 'preview'], { env, encoding: 'utf8' });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');

  assert.equal(res.status, 1, `unexpected exit status:\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}\n`);
  assert.ok(/No preview releases found/i.test(stderr), `expected preview missing message, got:\n${stderr}`);
  assert.doesNotMatch(stderr, /conditional binary operator expected/i);

  await rm(root, { recursive: true, force: true });
});

