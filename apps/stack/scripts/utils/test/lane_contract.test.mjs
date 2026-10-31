import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('apps/stack package scripts preserve the stack lane contract', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf-8'));
  assert.equal(packageJson.scripts.test, './bin/hstack-exec --script=test:local');
  assert.equal(packageJson.scripts['test:local'], 'pnpm --silent run test:unit');
  assert.equal(packageJson.scripts['test:unit'], './bin/hstack-exec --script=test:unit:local');
  assert.equal(packageJson.scripts['test:unit:local'], 'node ./scripts/test_ci.mjs');
  assert.equal(packageJson.scripts['test:integration'], 'node ./scripts/test_integration.mjs');
  assert.equal(packageJson.scripts['test:ci'], 'pnpm --silent run test:unit');
});
