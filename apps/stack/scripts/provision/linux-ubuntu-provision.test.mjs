import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

async function readIfExists(path) {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

test('linux provision (happier profile) runs corepack enable as root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-linux-provision-test-'));
  const binDir = join(root, 'bin');
  const logDir = join(root, 'logs');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(binDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const corepackLog = join(logDir, 'corepack.log');
  const aptLog = join(logDir, 'apt.log');

  const idPath = join(binDir, 'id');
  await writeFile(
    idPath,
    ['#!/usr/bin/env bash', 'if [[ "${1:-}" == "-u" ]]; then echo 1000; else echo "uid=1000"; fi'].join('\n') + '\n',
    'utf-8'
  );
  await chmod(idPath, 0o755);

  const sudoPath = join(binDir, 'sudo');
  await writeFile(
    sudoPath,
    ['#!/usr/bin/env bash', 'export RUN_AS_ROOT=1', 'exec "$@"'].join('\n') + '\n',
    'utf-8'
  );
  await chmod(sudoPath, 0o755);

  const aptPath = join(binDir, 'apt-get');
  await writeFile(
    aptPath,
    [
      '#!/usr/bin/env bash',
      `echo "apt-get $*" >> ${JSON.stringify(aptLog)}`,
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(aptPath, 0o755);

  const mkdirPath = join(binDir, 'mkdir');
  await writeFile(
    mkdirPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'for a in "$@"; do',
      '  if [[ "$a" == "/usr/local/share/corepack" ]]; then',
      '    exit 0',
      '  fi',
      'done',
      'exec /bin/mkdir "$@"',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(mkdirPath, 0o755);

  const nodePath = join(binDir, 'node');
  await writeFile(nodePath, ['#!/usr/bin/env bash', 'echo "v24.0.0"'].join('\n') + '\n', 'utf-8');
  await chmod(nodePath, 0o755);

  const corepackPath = join(binDir, 'corepack');
  await writeFile(
    corepackPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "corepack $* root=${RUN_AS_ROOT:-0}" >> ' + JSON.stringify(corepackLog),
      'if [[ "${1:-}" == "enable" && "${RUN_AS_ROOT:-0}" != "1" ]]; then',
      '  echo "enable must run as root" >&2',
      '  exit 13',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(corepackPath, 0o755);

  const yarnPath = join(binDir, 'yarn');
  await writeFile(yarnPath, ['#!/usr/bin/env bash', 'echo "1.22.22"'].join('\n') + '\n', 'utf-8');
  await chmod(yarnPath, 0o755);

  const scriptPath = join(__dirname, 'linux-ubuntu-provision.sh');
  const res = spawnSync('bash', [scriptPath, '--profile=happier'], {
    cwd: root,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    encoding: 'utf-8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const corepackOut = await readIfExists(corepackLog);
  assert.match(corepackOut, /corepack enable root=1/, 'expected corepack enable to be invoked via sudo/as_root');
  assert.ok(!corepackOut.includes('corepack enable root=0'), 'expected corepack enable not to run unprivileged');

  const aptOut = await readIfExists(aptLog);
  assert.match(aptOut, /apt-get update/, 'expected apt-get update to run');
  assert.match(aptOut, /apt-get install/, 'expected apt-get install to run');
});

test('linux provision (installer profile) does not touch node/corepack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-linux-provision-installer-test-'));
  const binDir = join(root, 'bin');
  const logDir = join(root, 'logs');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(binDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const corepackLog = join(logDir, 'corepack.log');

  const idPath = join(binDir, 'id');
  await writeFile(idPath, ['#!/usr/bin/env bash', 'echo 1000'].join('\n') + '\n', 'utf-8');
  await chmod(idPath, 0o755);

  const sudoPath = join(binDir, 'sudo');
  await writeFile(sudoPath, ['#!/usr/bin/env bash', 'export RUN_AS_ROOT=1', 'exec "$@"'].join('\n') + '\n', 'utf-8');
  await chmod(sudoPath, 0o755);

  const aptPath = join(binDir, 'apt-get');
  await writeFile(aptPath, ['#!/usr/bin/env bash', 'exit 0'].join('\n') + '\n', 'utf-8');
  await chmod(aptPath, 0o755);

  const corepackPath = join(binDir, 'corepack');
  await writeFile(
    corepackPath,
    [
      '#!/usr/bin/env bash',
      `echo "corepack $*" >> ${JSON.stringify(corepackLog)}`,
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(corepackPath, 0o755);

  const scriptPath = join(__dirname, 'linux-ubuntu-provision.sh');
  const res = spawnSync('bash', [scriptPath, '--profile=installer'], {
    cwd: root,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
    encoding: 'utf-8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  const corepackOut = await readIfExists(corepackLog);
  assert.equal(corepackOut.trim(), '', 'expected no corepack calls in installer profile');
});
