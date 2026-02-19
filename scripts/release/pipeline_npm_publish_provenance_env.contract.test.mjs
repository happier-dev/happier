import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

test('pipeline npm publish forces NPM_CONFIG_PROVENANCE off locally (overrides publishConfig.provenance)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-provenance-'));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const fakeNpx = path.join(binDir, 'npx');
  writeExecutable(
    fakeNpx,
    `#!/usr/bin/env bash
set -euo pipefail
echo "PROVENANCE=$NPM_CONFIG_PROVENANCE"
exit 0
`,
  );

  const tarballPath = path.join(tmpDir, 'pkg.tgz');
  fs.writeFileSync(tarballPath, 'dummy', 'utf8');

  const script = resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-tarball.mjs');

  const outLocal = execFileSync(
    process.execPath,
    [script, '--channel', 'preview', '--tarball', tarballPath],
    {
      cwd: repoRoot,
      env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(outLocal, /PROVENANCE=false/);

  const outGithub = execFileSync(
    process.execPath,
    [script, '--channel', 'preview', '--tarball', tarballPath],
    {
      cwd: repoRoot,
      env: { ...process.env, GITHUB_ACTIONS: 'true', PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}` },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(outGithub, /PROVENANCE=true/);
});

