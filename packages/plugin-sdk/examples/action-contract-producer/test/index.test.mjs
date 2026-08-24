import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('uses the canonical Triage protocol package for its target point', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

  assert.equal(packageJson.dependencies['@happier-dev/triage-protocol'], '0.0.0');
  assert.equal(Object.hasOwn(packageJson.dependencies, '@happier-dev/triage-sources-protocol'), false);
  assert.match(source, /TriageSourcesContributionPointV1/u);
  assert.doesNotMatch(source, /triage-sources-protocol/u);
});
