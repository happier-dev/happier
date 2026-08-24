import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('binds canonical Triage operations without an obsolete fixture dependency', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

  assert.equal(packageJson.dependencies['@happier-dev/triage-protocol'], '0.0.0');
  assert.equal(Object.hasOwn(packageJson.dependencies, '@happier-dev/triage-sources-protocol'), false);
  for (const role of ['listInstances', 'scan', 'get']) {
    assert.match(source, new RegExp(`sources\\.operations\\.${role}\\.bind\\(`, 'u'));
  }
  assert.doesNotMatch(source, /triage-sources-protocol/u);
});
