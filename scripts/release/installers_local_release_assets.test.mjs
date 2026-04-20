import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('install.sh --version resolves release assets from HAPPIER_RELEASE_ASSETS_DIR without fetching release metadata', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'happier-installers-local-assets-'));
  const fakeBinDir = join(scratch, 'bin');
  const assetsDir = join(scratch, 'assets');
  const installerPath = resolve(repoRoot, 'scripts', 'release', 'installers', 'install.sh');
  const curlPath = join(fakeBinDir, 'curl');
  const bashrcPath = join(scratch, '.bashrc');
  const archiveName = 'happier-v1.2.3-preview.4-darwin-arm64.tar.gz';

  execFileSync('mkdir', ['-p', fakeBinDir, assetsDir]);
  writeFileSync(join(assetsDir, archiveName), '');
  writeFileSync(
    curlPath,
    '#!/usr/bin/env bash\n' +
      'echo "curl should not be called when HAPPIER_RELEASE_ASSETS_DIR is set" >&2\n' +
      'exit 97\n',
  );
  chmodSync(curlPath, 0o755);
  writeFileSync(bashrcPath, '');

  const output = execFileSync('bash', [installerPath, '--version'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: scratch,
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
      SHELL: '/bin/bash',
      HAPPIER_CHANNEL: 'preview',
      HAPPIER_RELEASE_ASSETS_DIR: assetsDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.doesNotMatch(output, /Fetching .* release metadata/);
  assert.match(output, /Happier CLI installer version check/);
  assert.match(output, /- version: 1\.2\.3-preview\.4/);
});
