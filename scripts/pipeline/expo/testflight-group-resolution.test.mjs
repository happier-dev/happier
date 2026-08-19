import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveExternalGroupSelections } from './testflight-group-resolution.mjs';

test('resolveExternalGroupSelections matches groups by exact id as well as by exact name', () => {
  const groups = [
    {
      id: '78315e16-c539-43ae-a65e-4f465dccaf68',
      attributes: { name: 'Happier (dev)', isInternalGroup: false },
    },
    {
      id: 'internal-group-id',
      attributes: { name: 'Internal', isInternalGroup: true },
    },
  ];

  const resolved = resolveExternalGroupSelections({
    groups,
    selections: ['78315e16-c539-43ae-a65e-4f465dccaf68', 'Happier (dev)'],
  });

  assert.equal(resolved.length, 2);
  assert.equal(resolved[0]?.id, '78315e16-c539-43ae-a65e-4f465dccaf68');
  assert.equal(resolved[1]?.id, '78315e16-c539-43ae-a65e-4f465dccaf68');
});

test('resolveExternalGroupSelections rejects an explicit App Store Connect group id that is absent from the app group list', () => {
  const resolved = resolveExternalGroupSelections({
    groups: [],
    selections: ['78315e16-c539-43ae-a65e-4f465dccaf68'],
  });

  assert.equal(resolved[0], null);
});
