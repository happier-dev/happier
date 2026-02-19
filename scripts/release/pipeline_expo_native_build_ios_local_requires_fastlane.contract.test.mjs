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

test('expo native-build local iOS fails fast when fastlane is missing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-pipeline-eas-ios-fastlane-'));
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  // Provide an npx stub so the test doesn't accidentally invoke real EAS CLI if the preflight regresses.
  writeExecutable(path.join(binDir, 'npx'), ['#!/usr/bin/env bash', 'echo "NPX $*"', 'exit 0', ''].join('\n'));

  const env = {
    ...process.env,
    // Exclude Homebrew paths so `fastlane` isn't discovered via a developer machine install.
    PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
    EXPO_TOKEN: 'test-token',
  };

  try {
    execFileSync(
      process.execPath,
      [
        path.join(repoRoot, 'scripts', 'pipeline', 'expo', 'native-build.mjs'),
        '--platform',
        'ios',
        '--profile',
        'preview',
        '--out',
        path.join(dir, 'out.json'),
        '--build-mode',
        'local',
        '--artifact-out',
        path.join(dir, 'app.ipa'),
      ],
      { cwd: repoRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
    );
  } catch (err) {
    const e = /** @type {any} */ (err);
    const stdout = typeof e?.stdout === 'string' ? e.stdout : String(e?.stdout ?? '');
    const stderr = typeof e?.stderr === 'string' ? e.stderr : String(e?.stderr ?? '');
    assert.match(`${stdout}\n${stderr}`, /fastlane/i);
    return;
  }

  assert.fail('expected expo native-build local iOS to fail fast when fastlane is not on PATH');
});
