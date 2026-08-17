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
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(path.join(binDir, 'yarn'), [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    `printf 'yarn token=%q args=' "\${EXPO_TOKEN:-}" >> ${JSON.stringify(logPath)}`,
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
    `printf 'npx token=%q args=' "\${EXPO_TOKEN:-}" >> ${JSON.stringify(logPath)}`,
    `printf '%q ' "$@" >> ${JSON.stringify(logPath)}`,
    `printf '\n' >> ${JSON.stringify(logPath)}`,
    '',
  ].join('\n'));
  return { binDir, logPath };
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
    const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const prepareEnv = {
      ...process.env,
      PATH: `${stub.binDir}:${process.env.PATH ?? ''}`,
      CI: 'true',
      EXPO_TOKEN: '',
      SENTRY_AUTH_TOKEN: '',
    };

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
    assert.match(log, /yarn token='' args=.*expo export/);
    assert.match(log, /npx token=must-not-reach-candidate args=.*eas-cli@18\.0\.1 update/);
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
