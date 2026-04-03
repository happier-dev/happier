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

test('mobile-release-environments runs without node_modules (standalone repo checkout)', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'happier-mobile-env-standalone-'));

  // Copy only the minimum dependency-free graph we want to support in GitHub Actions before yarn install.
  copyFileInto(tmpRoot, 'scripts/pipeline/expo/mobile-release-environments.mjs');
  copyFileInto(tmpRoot, 'apps/ui/appVariantConfig.cjs');
  copyFileInto(tmpRoot, 'packages/release-runtime/releaseRings.cjs');

  const probePath = path.join(tmpRoot, 'probe.mjs');
  fs.writeFileSync(
    probePath,
    [
      "import { normalizeMobileReleaseEnvironment } from './scripts/pipeline/expo/mobile-release-environments.mjs';",
      "console.log(normalizeMobileReleaseEnvironment('dev'));",
      '',
    ].join('\n'),
    'utf8',
  );

  const raw = execFileSync(process.execPath, [probePath], {
    cwd: tmpRoot,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

  assert.equal(raw.trim(), 'publicdev');
});

