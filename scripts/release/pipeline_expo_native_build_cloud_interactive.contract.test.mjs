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

test('expo native-build cloud mode defaults to non-interactive outside a TTY (dry-run)', () => {
  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'native-build.mjs'),
      '--platform',
      'android',
      '--profile',
      'preview-apk',
      '--out',
      '/tmp/eas-build.json',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        EXPO_TOKEN: 'test-token',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] expo native build: mode=cloud platform=android profile=preview-apk/);
  assert.match(out, /\s--non-interactive\b/);
});

test('expo native-build cloud mode can schedule interactively and resolve the created build via EAS list/view', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-eas-cloud-interactive-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const outJson = path.join(dir, 'eas-build.json');
  const logPath = path.join(dir, 'npx.log');
  const gitLogPath = path.join(dir, 'git.log');
  const npxPath = path.join(binDir, 'npx');
  const gitPath = path.join(binDir, 'git');
  writeExecutable(
    gitPath,
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
      'if [[ "$1" == "rev-parse" && "$2" == "HEAD" ]]; then',
      '  echo "d324ebf14816a171fc6222a128f8e85e15028b2a"',
      '  exit 0',
      'fi',
      'echo "unexpected git invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );
  writeExecutable(
    npxPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      `echo "$*" >> ${JSON.stringify(logPath)}`,
      `env | grep '^GIT_CONFIG_' | sort >> ${JSON.stringify(logPath)} || true`,
      'if [[ "$*" == *" build --platform android --profile preview-apk"* ]] && [[ "$*" != *"--json"* ]]; then',
      '  echo "NPX $*"',
      '  exit 0',
      'fi',
      'if [[ "$*" == *"build:list"* ]]; then',
      '  printf \'[{"id":"old-build","platform":"android","createdAt":"2024-01-01T00:00:00.000Z"},{"id":"new-build","platform":"android","createdAt":"2099-01-01T00:00:00.000Z","buildDetailsPageUrl":"https://expo.dev/builds/new-build"}]\\n\'',
      '  exit 0',
      'fi',
      'if [[ "$*" == *"build:view new-build --json"* ]]; then',
      '  echo "NPX $*" >&2',
      '  printf \'{"id":"new-build","platform":"android","status":"IN_QUEUE","createdAt":"2099-01-01T00:00:00.000Z","buildDetailsPageUrl":"https://expo.dev/builds/new-build","artifacts":{"buildUrl":"https://expo.dev/artifacts/new-build.apk"}}\\n\'',
      '  exit 0',
      'fi',
      'if [[ "$*" == *"build:view new-build"* ]]; then',
      '  echo "Build details for new-build"',
      '  exit 0',
      'fi',
      'echo "unexpected npx invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );

  const stdout = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'native-build.mjs'),
      '--platform',
      'android',
      '--profile',
      'preview-apk',
      '--out',
      outJson,
      '--interactive',
      'true',
      '--dump-view',
      'false',
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

  assert.match(stdout, /NPX --yes eas-cli@.* build --platform android --profile preview-apk\b(?!.*--json)/);
  const npxLog = fs.readFileSync(logPath, 'utf8');
  assert.match(npxLog, /build:list .* --json --non-interactive/);
  assert.match(npxLog, /build:view new-build --json/);
  if (process.platform === 'darwin') {
    const gitLog = fs.existsSync(gitLogPath) ? fs.readFileSync(gitLogPath, 'utf8') : '';
    assert.doesNotMatch(gitLog, /config --get core\.ignorecase/);
    assert.doesNotMatch(gitLog, /config core\.ignorecase false/);
  }
  if (process.platform === 'darwin') {
    assert.match(npxLog, /GIT_CONFIG_KEY_\d+=core\.ignorecase/);
    assert.match(npxLog, /GIT_CONFIG_VALUE_\d+=false/);
  }

  const parsed = JSON.parse(fs.readFileSync(outJson, 'utf8'));
  assert.equal(parsed.id, 'new-build');
  assert.equal(parsed.platform, 'android');
});

test('expo native-build cloud mode fails closed when build:list does not contain a newly scheduled build', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-eas-cloud-stale-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const npxPath = path.join(binDir, 'npx');
  const gitPath = path.join(binDir, 'git');
  writeExecutable(
    gitPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "$1" == "rev-parse" && "$2" == "HEAD" ]]; then',
      '  echo "d324ebf14816a171fc6222a128f8e85e15028b2a"',
      '  exit 0',
      'fi',
      'if [[ "$1" == "config" ]]; then',
      '  exit 0',
      'fi',
      'echo "unexpected git invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );
  writeExecutable(
    npxPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [[ "$*" == *" build --platform android --profile preview-apk"* ]] && [[ "$*" != *"--json"* ]]; then',
      '  exit 0',
      'fi',
      'if [[ "$*" == *"build:list"* ]]; then',
      '  printf \'[{"id":"old-build","platform":"android","createdAt":"2024-01-01T00:00:00.000Z"}]\\n\'',
      '  exit 0',
      'fi',
      'echo "unexpected npx invocation: $*" >&2',
      'exit 1',
      '',
    ].join('\n'),
  );

  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'native-build.mjs'),
          '--platform',
          'android',
          '--profile',
          'preview-apk',
          '--out',
          path.join(dir, 'eas-build.json'),
          '--interactive',
          'true',
          '--dump-view',
          'false',
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
      ),
    /Unable to resolve the scheduled android cloud build/,
  );
});
