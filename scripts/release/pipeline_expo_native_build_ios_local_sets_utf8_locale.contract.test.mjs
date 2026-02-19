import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

test('expo native-build local iOS forces UTF-8 locale env for CocoaPods', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-eas-ios-locale-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  // Satisfy commandExists('fastlane') and commandExists('pod') checks.
  writeExecutable(path.join(binDir, 'fastlane'), ['#!/usr/bin/env bash', 'exit 0', ''].join('\n'));
  writeExecutable(path.join(binDir, 'pod'), ['#!/usr/bin/env bash', 'exit 0', ''].join('\n'));

  const outJson = path.join(dir, 'out.json');
  const artifactOut = path.join(dir, 'app.ipa');

  writeExecutable(
    path.join(binDir, 'npx'),
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "LANG=$LANG"',
      'echo "LC_ALL=$LC_ALL"',
      'if [ "${LANG:-}" != "en_US.UTF-8" ]; then echo "BAD_LANG" >&2; exit 1; fi',
      'if [ "${LC_ALL:-}" != "en_US.UTF-8" ]; then echo "BAD_LC_ALL" >&2; exit 1; fi',
      // Simulate `eas build --local --output <path>` by creating the output file.
      'out=""',
      'for ((i=1;i<=$#;i++)); do',
      '  if [ "${!i}" = "--output" ]; then',
      '    j=$((i+1))',
      '    out="${!j}"',
      '  fi',
      'done',
      'if [ -z "${out}" ]; then echo "missing --output" >&2; exit 1; fi',
      'mkdir -p "$(dirname "${out}")"',
      'head -c 1000001 /dev/zero > "${out}"',
      'exit 0',
      '',
    ].join('\n'),
  );

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    EXPO_TOKEN: 'test-token',
  };

  const stdout = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'native-build.mjs'),
      '--platform',
      'ios',
      '--profile',
      'preview',
      '--out',
      outJson,
      '--build-mode',
      'local',
      '--artifact-out',
      artifactOut,
    ],
    { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.match(stdout, /LANG=en_US\.UTF-8/);
  assert.match(stdout, /LC_ALL=en_US\.UTF-8/);
  assert.ok(fs.existsSync(artifactOut), 'expected local build artifact to be created');
});

