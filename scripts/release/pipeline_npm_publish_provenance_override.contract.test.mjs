import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-npm-provenance-'));
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

function runPublishTarball({ githubActions }) {
  const dir = makeTempDir();
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const tarballPath = path.join(dir, 'dummy.tgz');
  fs.writeFileSync(tarballPath, 'not-a-real-tarball', { encoding: 'utf8' });

  const npxPath = path.join(binDir, 'npx');
  writeExecutable(
    npxPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "NPM_CONFIG_PROVENANCE=${NPM_CONFIG_PROVENANCE-}"',
      'echo "GITHUB_ACTIONS=${GITHUB_ACTIONS-}"',
      'exit 0',
      '',
    ].join('\n'),
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    // Ensure the script is the one deciding, not the outer environment.
    NPM_CONFIG_PROVENANCE: '',
    GITHUB_ACTIONS: githubActions ? 'true' : '',
  };

  return execFileSync(
    process.execPath,
    [
      'scripts/pipeline/npm/publish-tarball.mjs',
      '--channel',
      'preview',
      '--tarball',
      tarballPath,
      '--npm-version',
      '11.5.1',
    ],
    { env, encoding: 'utf8' },
  );
}

test('publish-tarball sets NPM_CONFIG_PROVENANCE=false by default locally', () => {
  const stdout = runPublishTarball({ githubActions: false });
  assert.match(stdout, /NPM_CONFIG_PROVENANCE=false/);
});

test('publish-tarball sets NPM_CONFIG_PROVENANCE=true by default in GitHub Actions', () => {
  const stdout = runPublishTarball({ githubActions: true });
  assert.match(stdout, /NPM_CONFIG_PROVENANCE=true/);
});

