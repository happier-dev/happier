import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('build-ui-mobile-local submit jobs resolve flattened downloaded artifacts by basename', () => {
  const src = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'build-ui-mobile-local.yml'), 'utf8');

  const iosBlock = src.match(/submit_ios:\n([\s\S]*?)\n\s*$|submit_ios:\n([\s\S]*)/)?.[0] ?? '';
  const androidBlock = src.match(/submit_android:\n([\s\S]*?)\n  ota_update:/)?.[1] ?? '';

  for (const block of [androidBlock, iosBlock]) {
    assert.match(block, /\$\{GITHUB_WORKSPACE\}\/\$\{base\}/);
    assert.match(block, /\$\{GITHUB_WORKSPACE\}\/\$\{artifact_dir\}\/\$\{base\}/);
    assert.match(block, /find "\$\{GITHUB_WORKSPACE\}" -maxdepth 6 -type f -name "\$\{base\}" -print -quit/);
  }
});
