import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as owner from './sourceRuntimeDependencies.mjs';

test('dependency refusal publishes its own typed status and successful admission clears it', async () => {
  const decisions = [];
  const stop = owner.observeSourceRuntimeDependencies('/retained/entry.mjs', status => decisions.push(status));
  try {
    await assert.rejects(owner.assertSourceRuntimeDependenciesCurrent({ entrypoint: '/retained/entry.mjs', record: {} }),
      { code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', subtype: 'no_closure' });
    assert.deepEqual(decisions, [{ code: 'SOURCE_RUNTIME_RELOAD_REQUIRED', subtype: 'no_closure' }]);
    await owner.assertSourceRuntimeDependenciesCurrent({ entrypoint: '/other/entry.mjs', record: {} }).catch(() => {});
    assert.equal(decisions.length, 1);
    await owner.assertSourceRuntimeDependenciesCurrent({ entrypoint: '/retained/entry.mjs', record: null });
    assert.equal(decisions.at(-1), null);
  } finally { stop(); }
});
