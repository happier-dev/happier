import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

test('binds public Channels roles without declaring a target, descriptor, or renderer', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');

  assert.equal(packageJson.dependencies['@happier-dev/channels-protocol'], '0.0.0');
  assert.match(source, /from '@happier-dev\/channels-protocol\/v1'/u);
  assert.match(source, /ConversationProvidersContributionProtocolV1\.contribute\(\{/u);
  for (const role of ['setup', 'connectionTest', 'messageDeliver', 'connectionStop']) {
    assert.match(source, new RegExp(`roles\\.${role}\\.bind\\(`, 'u'));
  }
  assert.doesNotMatch(source, /\bdescriptor\s*:/u);
  assert.doesNotMatch(source, /\brenderers\s*:/u);
});
