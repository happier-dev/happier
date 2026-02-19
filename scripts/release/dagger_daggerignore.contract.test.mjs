import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

test('repo root provides .daggerignore excluding heavy host-only directories', () => {
  const p = path.join(repoRoot, '.daggerignore');
  assert.ok(fs.existsSync(p), 'expected .daggerignore to exist at repo root');

  const raw = fs.readFileSync(p, 'utf8');
  assert.ok(raw.includes('node_modules/'), 'expected node_modules to be excluded');
  assert.ok(raw.includes('dist/'), 'expected dist to be excluded');
  assert.ok(raw.includes('test-results/'), 'expected test-results to be excluded');
  assert.ok(raw.includes('.env'), 'expected env files to be excluded');
  assert.ok(raw.includes('.git/'), 'expected .git to be excluded');
});
