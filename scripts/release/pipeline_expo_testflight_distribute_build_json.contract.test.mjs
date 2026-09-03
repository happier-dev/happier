import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('expo-testflight-distribute dry-run does not require or consume planned build json output', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-testflight-planned-build-json-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  const cases = [
    { name: 'missing', contents: null },
    { name: 'stale Android metadata', contents: { mode: 'local', platform: 'android', artifactPath: '/tmp/Happier.apk' } },
  ];

  for (const fixture of cases) {
    const buildJsonPath = path.join(tmpDir, `${fixture.name.replaceAll(' ', '-')}.json`);
    if (fixture.contents) {
      fs.writeFileSync(buildJsonPath, `${JSON.stringify(fixture.contents, null, 2)}\n`, 'utf8');
    }

    const out = execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'expo-testflight-distribute',
        '--environment',
        'dev',
        '--build-json',
        buildJsonPath,
        '--external-groups',
        'Public Beta',
        '--dry-run',
        '--secrets-source',
        'env',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    assert.match(out, /\[pipeline\] testflight distribute: environment=dev/);
    assert.doesNotMatch(out, /artifact_path=|eas_build_id=/);
  }
});

test('expo-testflight-distribute dry-run accepts a planned EAS build json path without reading it', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-testflight-build-json-'));
  const buildJsonPath = path.join(tmpDir, 'eas_build.ios.json');
  fs.writeFileSync(
    buildJsonPath,
    `${JSON.stringify([{ id: 'eas-build-123', platform: 'IOS' }], null, 2)}\n`,
    'utf8',
  );

  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-testflight-distribute',
      '--environment',
      'dev',
      '--build-json',
      buildJsonPath,
      '--external-groups',
      'Public Beta',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] testflight distribute: environment=dev/);
  assert.ok(out.includes(buildJsonPath));
  assert.doesNotMatch(out, /eas_build_id=eas-build-123/);
  assert.doesNotMatch(out, /build_number=/);
});

test('expo-testflight-distribute dry-run accepts a planned local iOS build json path without reading it', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-testflight-local-build-json-'));
  const buildJsonPath = path.join(tmpDir, 'eas_build.ios.json');
  fs.writeFileSync(
    buildJsonPath,
    `${JSON.stringify({ mode: 'local', platform: 'ios', artifactPath: '/tmp/Happier.ipa' }, null, 2)}\n`,
    'utf8',
  );

  const out = execFileSync(
    process.execPath,
    [
      path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-testflight-distribute',
      '--environment',
      'dev',
      '--build-json',
      buildJsonPath,
      '--external-groups',
      'Public Beta',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        APPLE_API_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] testflight distribute: environment=dev/);
  assert.ok(out.includes(buildJsonPath));
  assert.doesNotMatch(out, /artifact_path=\/tmp\/Happier\.ipa/);
  assert.doesNotMatch(out, /eas_build_id=/);
});
