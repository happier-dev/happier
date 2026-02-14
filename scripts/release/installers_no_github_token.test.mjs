import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.sh does not require a GitHub token (does not crash under set -u)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-installer-no-token-'));
  const binDir = join(root, 'bin');
  const installDir = join(root, 'install');
  const outBinDir = join(root, 'out-bin');
  await mkdir(binDir, { recursive: true });
  await mkdir(installDir, { recursive: true });
  await mkdir(outBinDir, { recursive: true });

  const curlStubPath = join(binDir, 'curl');
  await writeFile(
    curlStubPath,
    `#!/usr/bin/env bash
set -euo pipefail

# Minimal curl stub used by installer tests.
# - For metadata calls (no -o), return an empty assets list so the installer exits
#   with a predictable "Unable to locate release assets" error.
# - For any -o download, just write an empty file.
out=""
for ((i=1; i<=$#; i++)); do
  if [[ "\${!i}" = "-o" ]]; then
    j=$((i+1))
    out="\${!j}"
    break
  fi
done
if [[ -n "$out" ]]; then
  : > "$out"
  exit 0
fi
printf '%s' '{"assets":[]}'
`,
    'utf8',
  );
  await chmod(curlStubPath, 0o755);

  const installerPath = join(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HAPPIER_CHANNEL: 'preview',
    HAPPIER_PRODUCT: 'cli',
    HAPPIER_INSTALL_DIR: installDir,
    HAPPIER_BIN_DIR: outBinDir,
    HAPPIER_NO_PATH_UPDATE: '1',
    HAPPIER_NONINTERACTIVE: '1',
    HAPPIER_GITHUB_TOKEN: '',
    GITHUB_TOKEN: '',
  };

  const res = spawnSync('bash', [installerPath], { env, encoding: 'utf8' });
  const stderr = String(res.stderr ?? '');
  assert.notEqual(res.status, 0);
  assert.match(stderr, /Unable to locate release assets/i);
  assert.doesNotMatch(stderr, /unbound variable/i);
});
