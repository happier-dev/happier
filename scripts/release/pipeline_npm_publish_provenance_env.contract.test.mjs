import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const admittedSha = 'a'.repeat(40);

function writeExecutable(filePath, contents) {
  fs.writeFileSync(filePath, contents, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

test('pipeline npm publish forces NPM_CONFIG_PROVENANCE off locally (overrides publishConfig.provenance)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-npm-provenance-'));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const fakeNpx = path.join(binDir, 'npx');
  const stubLogPath = path.join(tmpDir, 'npm-stub.log');
  const packageDir = path.join(tmpDir, 'package');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: 'happier-provenance-env-fixture', version: '1.2.3' }),
    'utf8',
  );
  fs.writeFileSync(path.join(packageDir, 'index.js'), 'export {};\n', 'utf8');
  const tarballPath = path.join(tmpDir, 'pkg.tgz');
  execFileSync('tar', ['-czf', tarballPath, '-C', tmpDir, 'package']);
  const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tarballPath)).digest('base64')}`;

  writeExecutable(
    fakeNpx,
    `#!/usr/bin/env bash
set -euo pipefail
printf "PROVENANCE=%s\\n" "\${NPM_CONFIG_PROVENANCE}" >> "\${NPM_STUB_LOG}"
if [[ "$*" == *"dist.integrity"* ]]; then
  printf "\\\"%s\\\"\\n" "\${NPM_STUB_INTEGRITY}"
elif [[ "$*" == *"dist-tags"* ]]; then
  printf "{\\\"next\\\":\\\"1.2.3\\\"}\\n"
elif [[ "$*" == *"dist-tag add"* || "$*" == *" publish "* ]]; then
  printf "ok\\n"
else
  echo "unexpected npm invocation: $*" >&2
  exit 1
fi
`,
  );

  const script = resolve(repoRoot, 'scripts', 'pipeline', 'npm', 'publish-tarball.mjs');

  const runPublish = (env) => {
    const stdout = execFileSync(
      process.execPath,
      [
        script,
        '--channel', 'preview',
        '--tarball', tarballPath,
        '--authorized-sha', admittedSha,
      ],
      {
        cwd: repoRoot,
        env,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );
    return `${stdout}\n${fs.readFileSync(stubLogPath, 'utf8')}`;
  };

  const baseEnv = {
    ...process.env,
    NPM_CONFIG_PROVENANCE: '',
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
    NPM_STUB_INTEGRITY: integrity,
    NPM_STUB_LOG: stubLogPath,
  };
  const outLocal = runPublish({ ...baseEnv, CI: '', GITHUB_ACTIONS: '' });

  assert.match(outLocal, /PROVENANCE=false/);

  const outGithub = runPublish({ ...baseEnv, GITHUB_ACTIONS: 'true' });

  assert.match(outGithub, /PROVENANCE=true/);
});
