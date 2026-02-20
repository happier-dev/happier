import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('macos lima VM script prints tips without executing backticks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-macos-lima-vm-test-'));
  const binDir = join(root, 'bin');
  const homeDir = join(root, 'home');
  const logDir = join(root, 'logs');
  await writeFile(join(root, '.keep'), 'ok\n', 'utf-8');
  await Promise.all([
    writeFile(join(root, 'README.txt'), 'tmp\n', 'utf-8'),
  ]);

  const { mkdir } = await import('node:fs/promises');
  await mkdir(binDir, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await mkdir(logDir, { recursive: true });

  const npxLog = join(logDir, 'npx.log');
  const limactlLog = join(logDir, 'limactl.log');

  const unamePath = join(binDir, 'uname');
  await writeFile(
    unamePath,
    ['#!/usr/bin/env bash', 'echo Darwin'].join('\n') + '\n',
    'utf-8'
  );
  await chmod(unamePath, 0o755);

  const npxPath = join(binDir, 'npx');
  await writeFile(
    npxPath,
    [
      '#!/usr/bin/env bash',
      `echo "npx $*" >> ${JSON.stringify(npxLog)}`,
      'exit 77',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(npxPath, 0o755);

  const pythonPath = join(binDir, 'python3');
  await writeFile(
    pythonPath,
    [
      '#!/usr/bin/env bash',
      'cat >/dev/null || true',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(pythonPath, 0o755);

  const limactlPath = join(binDir, 'limactl');
  await writeFile(
    limactlPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "limactl $*" >> ${JSON.stringify(limactlLog)}`,
      'LIMA_HOME_DIR="${LIMA_HOME:-${HOME}/.lima}"',
      'cmd="${1:-}"',
      'shift || true',
      'if [[ "$cmd" == "create" ]]; then',
      '  name=""',
      '  while [[ $# -gt 0 ]]; do',
      '    if [[ "$1" == "--name" ]]; then',
      '      name="$2"',
      '      shift 2',
      '      continue',
      '    fi',
      '    shift || true',
      '  done',
      '  if [[ -z "$name" ]]; then',
      '    echo "missing --name" >&2',
      '    exit 2',
      '  fi',
      '  dir="${LIMA_HOME_DIR}/${name}"',
      '  mkdir -p "$dir"',
      '  if [[ ! -f "$dir/lima.yaml" ]]; then',
      '    printf "%s\\n" "memory: \\"4GiB\\"" > "$dir/lima.yaml"',
      '  fi',
      '  exit 0',
      'fi',
      'exit 0',
    ].join('\n') + '\n',
    'utf-8'
  );
  await chmod(limactlPath, 0o755);

  const scriptPath = join(__dirname, 'macos-lima-vm.sh');

  const env = {
    ...process.env,
    HOME: homeDir,
    LIMA_HOME: join(homeDir, '.lima'),
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  };

  const res = spawnSync('bash', [scriptPath, 'happy-test'], {
    env,
    cwd: root,
    encoding: 'utf-8',
  });

  assert.equal(res.status, 0, `expected exit 0\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.match(res.stdout, /`--vm-ports`/, 'expected backticks to be printed literally');
  assert.match(res.stdout, /linux-ubuntu-provision\.sh/, 'expected guest provision script to be referenced');
  assert.match(res.stdout, /--profile=happier/, 'expected profile=happier to be documented');
  assert.match(res.stdout, /--profile=installer/, 'expected profile=installer to be documented');
  assert.match(res.stdout, /--profile=bare/, 'expected profile=bare to be documented');
  assert.equal(await fileExists(npxLog), false, 'expected script not to execute npx');

  const limactlOut = await readFile(limactlLog, 'utf-8');
  assert.match(limactlOut, /limactl (create|stop|start)/, 'expected script to invoke limactl');
});
