import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

function readRepoJson(relPath) {
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..', '..');
  const abs = path.join(repoRoot, relPath);
  assert.ok(fs.existsSync(abs), `Expected file at ${abs}`);
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

test('apps/ui defines eas-build-post-install to re-apply native patches after expo prebuild', () => {
  const pkg = readRepoJson('apps/ui/package.json');
  const scripts = pkg?.scripts ?? {};
  assert.equal(typeof scripts, 'object', 'Expected package.json scripts object');

  // EAS Build executes `eas-build-post-install` once after npm/yarn install + `expo prebuild` (if needed).
  // We need this to ensure patch-package tasks run after the final dependency install step in EAS.
  assert.equal(
    typeof scripts['eas-build-post-install'],
    'string',
    'Expected apps/ui/package.json to define scripts.eas-build-post-install',
  );
  assert.match(
    scripts['eas-build-post-install'],
    /postinstall:real|tools\/postinstall\.mjs/,
    'Expected eas-build-post-install to invoke the existing UI postinstall implementation',
  );
});

