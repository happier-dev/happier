import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

test('expo ota update passes case-sensitive git config to EAS on macOS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-eas-ota-git-env-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const npxLogPath = path.join(dir, 'npx.log');
  const yarnLogPath = path.join(dir, 'yarn.log');
  const gitLogPath = path.join(dir, 'git.log');

  writeExecutable(
    path.join(binDir, 'git'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "$*" >> ${JSON.stringify(gitLogPath)}`,
      'if [[ "$1" == "config" && "$2" == "--get" && "$3" == "core.ignorecase" ]]; then',
      '  echo "true"',
      '  exit 0',
      'fi',
      'if [[ "$1" == "config" && "$2" == "core.ignorecase" && "$3" == "false" ]]; then',
      '  exit 0',
      'fi',
      'echo "unexpected git invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );

  writeExecutable(
    path.join(binDir, 'yarn'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "$*" >> ${JSON.stringify(yarnLogPath)}`,
      'exit 0',
      '',
    ].join('\n'),
  );

  writeExecutable(
    path.join(binDir, 'npx'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "$*" >> ${JSON.stringify(npxLogPath)}`,
      `env | grep '^GIT_CONFIG_' | sort >> ${JSON.stringify(npxLogPath)} || true`,
      'if [[ "$*" == *" eas-cli@"*" update --channel development "* ]]; then',
      '  exit 0',
      'fi',
      'echo "unexpected npx invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );

  execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'ota-update.mjs'),
      '--environment',
      'development',
      '--interactive',
      'true',
      '--message',
      'development OTA case env test',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ''}`,
        EXPO_TOKEN: '',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const npxLog = fs.readFileSync(npxLogPath, 'utf8');
  assert.match(npxLog, /update --channel development/);
  if (process.platform === 'darwin') {
    const gitLog = fs.existsSync(gitLogPath) ? fs.readFileSync(gitLogPath, 'utf8') : '';
    assert.equal(gitLog, '');
    assert.match(npxLog, /GIT_CONFIG_KEY_\d+=core\.ignorecase/);
    assert.match(npxLog, /GIT_CONFIG_VALUE_\d+=false/);
  }
});
