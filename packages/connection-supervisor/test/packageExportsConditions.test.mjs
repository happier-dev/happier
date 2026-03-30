import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('package exports include an explicit import condition (TypeScript bundler resolution)', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const root = pkg?.exports?.['.'] ?? null;
  assert.equal(typeof root, 'object');
  assert.equal(typeof root.types, 'string');
  assert.equal(typeof root.import, 'string');
});

