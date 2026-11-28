import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const script = path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'ota-update.mjs');

test('dev OTA prepares candidate bytes without secrets and publishes them from trusted control', () => {
  const workflow = YAML.parse(fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'publish-ui-mobile-dev.yml'), 'utf8'));
  const prepare = workflow.jobs?.prepare_ota;
  const publish = workflow.jobs?.publish_ota;
  assert.ok(prepare, 'missing secret-free OTA preparation job');
  assert.equal(prepare.environment, undefined);
  assert.doesNotMatch(JSON.stringify(prepare), /EXPO_TOKEN|secrets\./);
  assert.match(JSON.stringify(prepare), /--phase prepare/);
  assert.ok(publish, 'missing trusted OTA publisher job');
  assert.equal(publish.environment, 'release-shared');
  assert.match(JSON.stringify(publish), /job\.workflow_sha/);
  assert.match(JSON.stringify(publish), /--phase publish/);
  assert.match(JSON.stringify(publish), /EXPO_TOKEN/);
  assert.doesNotMatch(JSON.stringify(workflow.jobs?.publish), /ui-mobile-release.*--action ota|Expo OTA update/);
});

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o700 });
}

function createStubBin(root) {
  const binDir = path.join(root, 'bin');
  const logPath = path.join(root, 'commands.log');
  const sourceSha = 'a'.repeat(40);
  fs.mkdirSync(binDir, { recursive: true });
  // Remote source mirrors omit .git; model only the Git process boundary.
  writeExecutable(path.join(binDir, 'git'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '[[ "$*" == "rev-parse HEAD" ]] || exit 1',
    `printf '%s\\n' '${sourceSha}'`,
    '',
  ].join('\n'));
  writeExecutable(path.join(binDir, 'pnpm'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `printf 'pnpm token=%q args=' "\${EXPO_TOKEN:-}" >> ${JSON.stringify(logPath)}`,
    `printf '%q ' "$@" >> ${JSON.stringify(logPath)}`,
    `printf '\n' >> ${JSON.stringify(logPath)}`,
    'if [[ " $* " == *" expo export "* ]]; then',
    '  out=""',
    '  while [[ $# -gt 0 ]]; do',
    '    if [[ "$1" == "--output-dir" ]]; then out="$2"; shift 2; else shift; fi',
    '  done',
    '  mkdir -p "$out/assets"',
    '  printf "%s\n" "prepared bundle" > "$out/bundle.js"',
    '  printf "%s\n" "prepared asset" > "$out/assets/a.txt"',
    'fi',
    '',
  ].join('\n'));
  writeExecutable(path.join(binDir, 'npx'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `printf 'npx token=%q runtime=%q args=' "\${EXPO_TOKEN:-}" "\${HAPPIER_EXPO_RUNTIME_VERSION:-}" >> ${JSON.stringify(logPath)}`,
    `printf '%q ' "$@" >> ${JSON.stringify(logPath)}`,
    `printf '\n' >> ${JSON.stringify(logPath)}`,
    'if [[ " $* " == *" fingerprint:generate "* ]]; then',
    '  printf \'{"hash":"%s","sources":[{"type":"contents","id":"runtime","hash":"%s"}]}\\n\' "${STUB_FINGERPRINT_SOURCE_HASH:-prepared}" "${STUB_FINGERPRINT_SOURCE_HASH:-prepared}"',
    'fi',
    '',
  ].join('\n'));
  return { binDir, logPath, sourceSha };
}

function run(args, env) {
  return execFileSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });
}

test('prepared OTA publication never executes candidate commands with EXPO_TOKEN and binds exact artifact bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-ota-prepared-'));
  try {
    const stub = createStubBin(root);
    const preparedDir = path.join(root, 'prepared');
    const sourceSha = stub.sourceSha;
    const prepareEnv = {
      ...process.env,
      PATH: `${stub.binDir}:${process.env.PATH ?? ''}`,
      npm_execpath: path.join(stub.binDir, 'pnpm'),
      CI: 'true',
      EXPO_TOKEN: '',
      SENTRY_AUTH_TOKEN: '',
    };

    assert.throws(() => run([
      '--phase', 'prepare',
      '--environment', 'preview',
      '--platform', 'android',
      '--source-sha', 'b'.repeat(40),
      '--input-dir', preparedDir,
    ], prepareEnv), /Prepared OTA source SHA does not match the checked-out candidate/);

    run([
      '--phase', 'prepare',
      '--environment', 'preview',
      '--platform', 'android',
      '--source-sha', sourceSha,
      '--input-dir', preparedDir,
    ], prepareEnv);

    const publishEnv = {
      ...prepareEnv,
      EXPO_TOKEN: 'must-not-reach-candidate',
    };

    const prepared = JSON.parse(fs.readFileSync(path.join(preparedDir, 'happier-ota-prepared.json'), 'utf8'));
    assert.equal(prepared.sourceSha, sourceSha);
    assert.equal(prepared.environment, 'preview');
    assert.equal(prepared.platform, 'android');
    assert.ok(Array.isArray(prepared.files) && prepared.files.length >= 2);

    const message = 'release $(touch /tmp/happier-ota-message-injection) `id`';
    run([
      '--phase', 'publish',
      '--environment', 'preview',
      '--platform', 'android',
      '--message', message,
      '--expected-source-sha', sourceSha,
      '--input-dir', preparedDir,
      '--interactive', 'false',
    ], publishEnv);

    const log = fs.readFileSync(stub.logPath, 'utf8');
    const preparedBeforeExport = log.split('\n').findIndex(line => line.includes('run build:browser-bundles'));
    const exportStarted = log.split('\n').findIndex(line => line.includes('expo export'));
    assert.ok(preparedBeforeExport >= 0 && preparedBeforeExport < exportStarted,
      'OTA must generate the ignored browser bundles on the exporting host before Expo');
    assert.match(log, /pnpm token='' args=.*expo export/);
    assert.match(log, /npx token=must-not-reach-candidate runtime=\S* args=.*eas-cli@18\.0\.1 update/);
    assert.match(log, /--skip-bundler/);
    assert.match(log, /--input-dir/);
    assert.match(log, /happier-ota-message-injection/);
    assert.equal(fs.existsSync('/tmp/happier-ota-message-injection'), false);

    fs.appendFileSync(path.join(preparedDir, 'bundle.js'), 'tampered\n');
    assert.throws(() => run([
      '--phase', 'publish',
      '--environment', 'preview',
      '--platform', 'android',
      '--message', 'tamper test',
      '--expected-source-sha', sourceSha,
      '--input-dir', preparedDir,
      '--interactive', 'false',
    ], publishEnv));
    const afterTamper = fs.readFileSync(stub.logPath, 'utf8');
    assert.equal((afterTamper.match(/^npx /gm) ?? []).length, 1, 'tampered bytes must be rejected before EAS executes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('prepared public dev OTA publishes with the runtime bound at preparation, without recomputing it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-ota-prepared-runtime-'));
  try {
    const stub = createStubBin(root);
    const preparedDir = path.join(root, 'prepared');
    const env = { ...process.env, PATH: `${stub.binDir}:${process.env.PATH ?? ''}`, npm_execpath: path.join(stub.binDir, 'pnpm'),
      CI: 'true', EXPO_TOKEN: '', SENTRY_AUTH_TOKEN: '', STUB_FINGERPRINT_SOURCE_HASH: 'prepared-runtime' };
    run(['--phase', 'prepare', '--environment', 'publicdev', '--platform', 'ios', '--source-sha', stub.sourceSha,
      '--input-dir', preparedDir], env);
    const prepared = JSON.parse(fs.readFileSync(path.join(preparedDir, 'happier-ota-prepared.json'), 'utf8'));
    assert.match(prepared.runtimeVersion, /^[0-9a-f]{40}$/);

    // The trusted publisher's reduced install would fingerprint differently; it must not recompute.
    run(['--phase', 'publish', '--environment', 'publicdev', '--platform', 'ios', '--message', 'm',
      '--expected-source-sha', stub.sourceSha, '--input-dir', preparedDir, '--interactive', 'false'],
    { ...env, EXPO_TOKEN: 'publisher', STUB_FINGERPRINT_SOURCE_HASH: 'publisher-runtime' });
    const lines = fs.readFileSync(stub.logPath, 'utf8').split('\n');
    assert.equal(lines.filter((line) => line.includes('fingerprint:generate')).length, 1, 'only preparation fingerprints');
    const update = lines.find((line) => line.includes(' update '));
    assert.ok(update?.includes(`runtime=${prepared.runtimeVersion}`), update);

    const metadataPath = path.join(preparedDir, 'happier-ota-prepared.json');
    fs.writeFileSync(metadataPath, JSON.stringify({ ...prepared, runtimeVersion: 'not-a-fingerprint' }));
    assert.throws(() => run(['--phase', 'publish', '--environment', 'publicdev', '--platform', 'ios', '--message', 'm',
      '--expected-source-sha', stub.sourceSha, '--input-dir', preparedDir, '--interactive', 'false'],
    { ...env, EXPO_TOKEN: 'publisher' }), /canonical fingerprint hash/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
