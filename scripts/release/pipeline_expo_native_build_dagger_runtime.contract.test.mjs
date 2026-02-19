import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('expo native-build wrapper allows long-running Android builds (timeout >= 4h)', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'native-build.mjs'), 'utf8');
  assert.match(
    src,
    /timeout:\s*extra\?\.\s*timeoutMs\s*\?\?\s*4\s*\*\s*60\s*\*\s*60_000/,
    'expected native-build subprocess timeout to be >= 4h (Android local builds can exceed 60m)',
  );
});

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-expo-dagger-'));
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

test('expo native-build can delegate local Android builds to Dagger runtime', () => {
  const dir = makeTempDir();
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  const artifactOut = path.join(dir, 'happier-preview-android.apk');
  const outJson = path.join(dir, 'eas_build_android.json');

  const daggerPath = path.join(binDir, 'dagger');
  writeExecutable(
    daggerPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'echo "DAGGER $*"',
      // Create placeholder outputs expected by the pipeline wrapper.
      // The wrapper exports the function result to an output directory (-o),
      // and the module writes files into that directory using the provided names.
      'outdir=""',
      'artifact_name=""',
      'outjson_name=""',
      'for ((i=1;i<=$#;i++)); do',
      '  if [ "${!i}" = "-o" ]; then j=$((i+1)); outdir="${!j}"; fi',
      '  if [ "${!i}" = "--artifact-name" ]; then j=$((i+1)); artifact_name="${!j}"; fi',
      '  if [ "${!i}" = "--out-json-name" ]; then j=$((i+1)); outjson_name="${!j}"; fi',
      'done',
      'if [ -z "${outdir}" ] || [ -z "${artifact_name}" ] || [ -z "${outjson_name}" ]; then echo "missing outputs" >&2; exit 1; fi',
      'mkdir -p "${outdir}"',
      'artifact="${outdir}/${artifact_name}"',
      'outjson="${outdir}/${outjson_name}"',
      'head -c 1000001 /dev/zero > "${artifact}"',
      'printf \'{"mode":"local","platform":"android","profile":"preview-apk","artifactPath":"%s"}\\n\' "${artifact}" > "${outjson}"',
      'exit 0',
      '',
    ].join('\n'),
  );

  const gitPath = path.join(binDir, 'git');
  writeExecutable(
    gitPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'if [ "${1:-}" != "ls-files" ]; then echo "unexpected git args: $*" >&2; exit 1; fi',
      'printf "package.json\\0yarn.lock\\0apps/ui/package.json\\0scripts/pipeline/expo/native-build.mjs\\0dagger/src/index.ts\\0"',
      '',
    ].join('\n'),
  );

  // The production pipeline validates Docker amd64 emulation before running the Android build container.
  // In this contract test we stub docker so it doesn't attempt to start real containers.
  const dockerPath = path.join(binDir, 'docker');
  writeExecutable(
    dockerPath,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
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
      'android',
      '--profile',
      'preview-apk',
      '--out',
      outJson,
      '--build-mode',
      'local',
      '--local-runtime',
      'dagger',
      '--artifact-out',
      artifactOut,
    ],
    { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
  );

  assert.match(stdout, /\[pipeline\] expo native build:/);
  assert.match(stdout, /runtime=dagger/);
  assert.match(stdout, /DAGGER --progress plain -m \.\/dagger call -o .* expo-android-local-build/);
  assert.match(stdout, /--repo\b/);
  assert.ok(fs.existsSync(artifactOut), 'expected dagger runtime to create/export artifact');
  assert.ok(fs.existsSync(outJson), 'expected dagger runtime to create/export metadata json');
});
