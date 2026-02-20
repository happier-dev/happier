import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

function run(args, env = {}) {
  return spawnSync(process.execPath, [path.join(repoRoot, 'scripts', 'pipeline', 'run.mjs'), ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('pipeline run exposes tauri-build-updater-artifacts (dry-run)', () => {
  const res = run(
    [
      'tauri-build-updater-artifacts',
      '--environment',
      'preview',
      '--build-version',
      '0.0.0-preview.1',
      '--tauri-target',
      'x86_64-unknown-linux-gnu',
      '--ui-dir',
      'apps/ui',
      '--dry-run',
    ],
    {
      TAURI_SIGNING_PRIVATE_KEY: '/tmp/tauri.signing.key',
      APPLE_SIGNING_IDENTITY: 'Developer ID Application: Dummy',
    },
  );
  assert.equal(res.status, 0, `expected exit 0, got ${res.status} stderr=${res.stderr}`);
});

test('pipeline run exposes tauri-notarize-macos-artifacts (dry-run)', () => {
  const res = run(
    [
      'tauri-notarize-macos-artifacts',
      '--ui-dir',
      'apps/ui',
      '--tauri-target',
      'aarch64-apple-darwin',
      '--dry-run',
    ],
  );
  assert.equal(res.status, 0, `expected exit 0, got ${res.status} stderr=${res.stderr}`);
});

test('pipeline run exposes tauri-collect-updater-artifacts (dry-run)', () => {
  const res = run(
    [
      'tauri-collect-updater-artifacts',
      '--environment',
      'preview',
      '--platform-key',
      'linux-x64',
      '--ui-version',
      '0.0.0',
      '--tauri-target',
      'x86_64-unknown-linux-gnu',
      '--ui-dir',
      'apps/ui',
      '--dry-run',
    ],
  );
  assert.equal(res.status, 0, `expected exit 0, got ${res.status} stderr=${res.stderr}`);
});

