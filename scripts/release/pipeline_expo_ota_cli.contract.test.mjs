import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI can run Expo OTA update in dry-run for supported non-production lanes', async () => {
  for (const environment of ['development', 'canary', 'preview']) {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'expo', 'ota-update.mjs'),
        '--environment',
        environment,
        '--message',
        `${environment} OTA test message`,
        '--dry-run',
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
    assert.match(out, new RegExp(`--channel ${environment}`));
  }
});

test('pipeline CLI allows interactive local override for Expo OTA dry-runs', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'expo', 'ota-update.mjs'),
      '--environment',
      'development',
      '--interactive',
      'true',
      '--message',
      'development OTA test message',
      '--dry-run',
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

  assert.match(out, /\[pipeline\] expo ota: environment=development/);
  assert.doesNotMatch(out, /\s--non-interactive\b/);
});

test('pipeline CLI allows interactive local Expo OTA dry-runs without EXPO_TOKEN', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'expo', 'ota-update.mjs'),
      '--environment',
      'development',
      '--interactive',
      'true',
      '--message',
      'development OTA test message',
      '--dry-run',
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

  assert.match(out, /\[pipeline\] expo ota: environment=development/);
  assert.doesNotMatch(out, /\s--non-interactive\b/);
});

test('pipeline CLI forwards explicit interactive setting to Expo OTA', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'expo', 'ota-update.mjs'),
      '--environment',
      'development',
      '--interactive',
      'false',
      '--message',
      'development OTA test message',
      '--dry-run',
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

  assert.match(out, /--channel development/);
  assert.match(out, /--non-interactive\b/);
});
