import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveExternalGroupSelections } from './testflight-group-resolution.mjs';

test('resolveExternalGroupSelections ignores internal groups and resolves by id or name', () => {
  const groups = [
    { id: 'internal', attributes: { name: 'Internal', isInternalGroup: true } },
    { id: 'beta-a', attributes: { name: 'Beta A', isInternalGroup: false } },
    { id: 'beta-b', attributes: { name: 'Beta B', isInternalGroup: false } },
  ];

  assert.deepEqual(resolveExternalGroupSelections({ groups, selections: ['beta-a', 'Beta B', 'missing'] }), [
    groups[1],
    groups[2],
    null,
  ]);
});

test('resolveExternalGroupSelections de-duplicates repeated external group selections', () => {
  const groups = [
    { id: 'beta-a', attributes: { name: 'Beta A', isInternalGroup: false } },
    { id: 'beta-b', attributes: { name: 'Beta B', isInternalGroup: false } },
  ];

  assert.deepEqual(resolveExternalGroupSelections({ groups, selections: ['beta-a', 'Beta A', 'beta-b', 'beta-b'] }), [
    groups[0],
    groups[1],
  ]);
});
