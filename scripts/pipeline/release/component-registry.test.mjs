import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyChangedPaths, deriveVersionedComponentChanges } from './component-registry.mjs';

test('packages/cli-common changes trigger cli/stack/server versioned component bumps', () => {
  const classified = classifyChangedPaths([
    'packages/cli-common/src/firstPartyRuntime/installVersionedPayload.ts',
  ]);

  assert.equal(classified.cli_stack_shared, true);

  const versioned = deriveVersionedComponentChanges(classified);
  assert.equal(versioned.cli, true);
  assert.equal(versioned.stack, true);
  assert.equal(versioned.server, true);
  assert.equal(versioned.app, false);
});
