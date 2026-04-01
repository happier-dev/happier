import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function copyFileInto(tmpRoot, relPath) {
  const src = path.join(repoRoot, relPath);
  const dest = path.join(tmpRoot, relPath);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return dest;
}

test('resolve-public-release-channel-meta runs without node_modules (standalone repo checkout)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-release-meta-standalone-'));

  // Copy only the minimum dependency-free graph we want to support in GitHub Actions before yarn install.
  const scriptPath = copyFileInto(tmpRoot, 'scripts/pipeline/release/resolve-public-release-channel-meta.mjs');
  copyFileInto(tmpRoot, 'scripts/pipeline/release/lib/public-release-rings.mjs');
  copyFileInto(tmpRoot, 'packages/release-runtime/releaseRings.cjs');

  const raw = execFileSync(process.execPath, [scriptPath, '--channel', 'dev'], {
    cwd: tmpRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  const parsed = JSON.parse(raw);
  assert.equal(parsed.channel_id, 'publicdev');
  assert.equal(parsed.channel_label, 'dev');
  assert.equal(parsed.source_ref, 'dev');
});
