import assert from 'node:assert/strict';
import test from 'node:test';

test('declares one reported daemon operation and reports bounded progress', async () => {
  const registrations = new Map();
  const { activate, manifest } = await import('../index.ts');

  activate({
    actions: {
      register(id, handler) {
        registrations.set(id, handler);
      },
    },
  });

  const declaration = manifest.contributes.actions.find((action) => action.id === 'rebuild-index');
  assert.deepEqual(declaration.operation, {
    version: 1,
    visibility: 'activity',
    progress: 'reported',
    presentation: { onStart: 'current' },
  });
  assert.equal(declaration.execution.target, 'daemon');

  const updates = [];
  const handler = registrations.get('rebuild-index');
  const result = await handler({}, {
    operation: { update: (progress) => updates.push(progress) },
  });

  assert.deepEqual(updates, [
    { phase: 'discovering', label: 'Discovering files' },
    { phase: 'indexing', label: 'Indexing files', current: 1, total: 2 },
    { phase: 'indexing', label: 'Indexing files', current: 2, total: 2 },
  ]);
  assert.deepEqual(result, { indexed: 2 });
});
