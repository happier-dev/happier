import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { resolveCliHomeDirForIdentity } from './cli_identities.mjs';

test('identity scoping resolves one sibling home from default, container, or scoped inputs', () => {
  const root = join('stack-state', 'agent-qa-voice-dev');
  const identities = join(root, 'cli-identities');
  const expected = join(identities, 'account-d');
  for (const cliHomeDir of [
    join(root, 'cli'),
    identities,
    expected,
    join(identities, 'account-b'),
    `${expected}/`,
    join(root, 'custom-home'),
  ]) {
    assert.equal(resolveCliHomeDirForIdentity({ cliHomeDir, identity: 'account-d' }), expected, cliHomeDir);
  }
});

test('default identity preserves the explicitly selected home', () => {
  const cliHomeDir = join('stack-state', 'cli-identities', 'account-d');
  assert.equal(resolveCliHomeDirForIdentity({ cliHomeDir, identity: 'default' }), cliHomeDir);
});
