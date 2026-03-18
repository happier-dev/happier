import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('pipeline CLI can download Android APK (dry-run) from EAS build JSON', async () => {
  for (const environment of ['development', 'canary', 'preview', 'production']) {
    const out = execFileSync(
      process.execPath,
      [
        resolve(repoRoot, 'scripts', 'pipeline', 'expo', 'download-android-apk.mjs'),
        '--environment',
        environment,
        '--build-json',
        '/tmp/eas_build.json',
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

    assert.match(out, new RegExp(`\\[pipeline\\] expo download apk: environment=${environment}`));
    assert.match(out, /would copy .* -> .*happier-(development|canary|preview|production)-android/);
  }
});
