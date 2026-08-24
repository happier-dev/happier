import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const admittedSha = 'a'.repeat(40);

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

  const packageDir = path.join(dir, 'package');
  fs.mkdirSync(packageDir, { recursive: true });
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: 'happier-provenance-fixture', version: '1.2.3' }),
    'utf8',
  );
  fs.writeFileSync(path.join(packageDir, 'index.js'), 'export {};\n', 'utf8');
  const tarballPath = path.join(dir, 'fixture.tgz');
  execFileSync('tar', ['-czf', tarballPath, '-C', dir, 'package']);
  const integrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tarballPath)).digest('base64')}`;
  const stubLogPath = path.join(dir, 'npm-stub.log');

  const npxPath = path.join(binDir, 'npx');
  writeExecutable(
    npxPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'printf "NPM_CONFIG_PROVENANCE=%s\\n" "${NPM_CONFIG_PROVENANCE-}" >> "${NPM_STUB_LOG}"',
      'if [[ "$*" == *"dist.integrity"* ]]; then',
      '  printf "\\\"%s\\\"\\n" "${NPM_STUB_INTEGRITY}"',
      'elif [[ "$*" == *"dist-tags"* ]]; then',
      '  printf "{\\\"next\\\":\\\"1.2.3\\\"}\\n"',
      'elif [[ "$*" == *"dist-tag add"* || "$*" == *" publish "* ]]; then',
      '  printf "ok\\n"',
      'else',
      '  echo "unexpected npm invocation: $*" >&2',
      '  exit 1',
      'fi',
      '',
    ].join('\n'),
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    // Ensure the script is the one deciding, not the outer environment.
    NPM_CONFIG_PROVENANCE: '',
    GITHUB_ACTIONS: githubActions ? 'true' : '',
    NPM_STUB_INTEGRITY: integrity,
    NPM_STUB_LOG: stubLogPath,
  };

  const stdout = execFileSync(
    process.execPath,
    [
      'scripts/pipeline/npm/publish-tarball.mjs',
      '--channel',
      'preview',
      '--tarball',
      tarballPath,
      '--npm-version',
      '11.5.1',
      '--authorized-sha',
      admittedSha,
    ],
    { env, encoding: 'utf8' },
  );
  return `${stdout}\n${fs.readFileSync(stubLogPath, 'utf8')}`;
}

test('publish-tarball sets NPM_CONFIG_PROVENANCE=false by default locally', () => {
  const stdout = runPublishTarball({ githubActions: false });
  assert.match(stdout, /NPM_CONFIG_PROVENANCE=false/);
});

test('publish-tarball sets NPM_CONFIG_PROVENANCE=true by default in GitHub Actions', () => {
  const stdout = runPublishTarball({ githubActions: true });
  assert.match(stdout, /NPM_CONFIG_PROVENANCE=true/);
});
