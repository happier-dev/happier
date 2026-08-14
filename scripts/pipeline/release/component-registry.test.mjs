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
  assert.equal(versioned.app, true);
});

test('every UI workspace dependency family triggers an app release without pretending UI source changed', () => {
  for (const changedPath of [
    'packages/plugin-ui/src/components/Button.tsx',
    'packages/plugin-sdk/src/ui/contributions.ts',
    'packages/plugins/claude/src/ui/descriptor.ts',
    'packages/connection-supervisor/src/index.ts',
  ]) {
    const classified = classifyChangedPaths([changedPath]);
    assert.equal(classified.ui, false, changedPath);
    assert.equal(classified.ui_dependencies, true, changedPath);
    assert.equal(deriveVersionedComponentChanges(classified).app, true, changedPath);
  }
});
