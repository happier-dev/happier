import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tauri notarize-macos-artifacts script supports dry-run', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'tauri', 'notarize-macos-artifacts.mjs'),
      '--ui-dir',
      'apps/ui',
      '--tauri-target',
      'aarch64-apple-darwin',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      env: { ...process.env },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  assert.match(out, /\bxcrun notarytool submit\b/);
  assert.match(out, /\btauri signer sign\b/);
});

test('tauri notarization retries transient notarytool submit timeouts only', async () => {
  const srcPath = resolve(repoRoot, 'scripts', 'pipeline', 'tauri', 'notarize-macos-artifacts.mjs');
  const src = await import(srcPath);
  assert.equal(typeof src.shouldRetryNotarytoolSubmitError, 'function');

  const transient = Object.assign(new Error('Command failed: xcrun notarytool submit app.zip'), {
    stderr: 'Error: HTTPError(statusCode: nil) NSURLErrorDomain Code=-1001 "The request timed out."',
  });
  assert.equal(src.shouldRetryNotarytoolSubmitError(transient), true);

  const unrelated = Object.assign(new Error('Command failed: xcrun stapler staple Happier.app'), {
    stderr: 'The request timed out.',
  });
  assert.equal(src.shouldRetryNotarytoolSubmitError(unrelated), false);
});
