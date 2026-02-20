import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

test('tauri collect-updater-artifacts script supports dry-run', async () => {
  const out = execFileSync(
    process.execPath,
    [
      resolve(repoRoot, 'scripts', 'pipeline', 'tauri', 'collect-updater-artifacts.mjs'),
      '--environment',
      'preview',
      '--platform-key',
      'darwin-aarch64',
      '--ui-version',
      '1.2.3',
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

  assert.match(out, /dist\/tauri\/updates\/darwin-aarch64/);
  assert.match(out, /happier-ui-desktop-preview-darwin-aarch64/);
});

