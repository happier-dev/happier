import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI can run Expo OTA update in dry-run for supported non-stable lanes', async () => {
  for (const environment of ['internaldev', 'internalpreview', 'dev', 'preview']) {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
        'expo-ota',
        '--environment',
        environment,
        '--message',
        `${environment} OTA test message`,
        '--dry-run',
        '--secrets-source',
        'env',
      ],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          EXPO_TOKEN: 'expo-token',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 30_000,
      },
    );

    assert.match(out, new RegExp(`\\[pipeline\\] expo ota: environment=${environment}`));
    assert.match(out, /scripts\/pipeline\/expo\/ota-update\.mjs/);
  }
});

test('pipeline CLI allows interactive local override for Expo OTA dry-runs', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-ota',
      '--environment',
      'internaldev',
      '--interactive',
      'true',
      '--message',
      'internaldev OTA test message',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        EXPO_TOKEN: 'expo-token',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] expo ota: environment=internaldev/);
  assert.doesNotMatch(out, /\s--non-interactive\b/);
});

test('pipeline CLI allows interactive local Expo OTA dry-runs without EXPO_TOKEN', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-ota',
      '--environment',
      'internaldev',
      '--interactive',
      'true',
      '--message',
      'internaldev OTA test message',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        EXPO_TOKEN: '',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\[pipeline\] expo ota: environment=internaldev/);
  assert.doesNotMatch(out, /\s--non-interactive\b/);
});

test('pipeline CLI forwards explicit interactive setting to Expo OTA', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-ota',
      '--environment',
      'internaldev',
      '--interactive',
      'false',
      '--message',
      'internaldev OTA test message',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        EXPO_TOKEN: 'expo-token',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /scripts\/pipeline\/expo\/ota-update\.mjs/);
  assert.match(out, /--interactive\"?\s+\"?false\b/);
});

test('pipeline CLI forwards an explicit runtime version to Expo OTA dry-runs', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'run.mjs'),
      'expo-ota',
      '--environment',
      'preview',
      '--runtime-version',
      '18',
      '--message',
      'preview OTA runtime 18 test message',
      '--dry-run',
      '--secrets-source',
      'env',
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        EXPO_TOKEN: 'expo-token',
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /scripts\/pipeline\/expo\/ota-update\.mjs/);
  assert.match(out, /--runtime-version\"?\s+\"?18\b/);
});
