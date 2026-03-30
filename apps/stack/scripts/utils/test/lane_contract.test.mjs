import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

test('apps/stack package scripts preserve the stack lane contract', async () => {
  const packageJson = JSON.parse(await readFile(join(process.cwd(), 'package.json'), 'utf-8'));
  assert.equal(packageJson.scripts.test, 'yarn -s test:unit');
  assert.equal(packageJson.scripts['test:unit'], 'node ./scripts/test_ci.mjs');
  assert.equal(packageJson.scripts['test:integration'], 'node ./scripts/test_integration.mjs');
  assert.equal(packageJson.scripts['test:ci'], 'yarn -s test:unit');
});
