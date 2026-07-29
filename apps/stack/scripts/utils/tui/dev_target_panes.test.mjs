import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDevTargetPaneSpecs,
  routeDevTargetLogPaneId,
} from './dev_target_panes.mjs';

test('dev target panes add one Mutagen owner and one pane per configured remote worker', () => {
  assert.deepEqual(
    createDevTargetPaneSpecs([{ name: 'linux' }, { name: 'windows' }]),
    [
      { id: 'mutagen', title: 'mutagen sync', visible: true, kind: 'log' },
      { id: 'remote-linux', title: 'remote linux', visible: true, kind: 'log' },
      { id: 'remote-windows', title: 'remote windows', visible: true, kind: 'log' },
    ],
  );
});

test('dev target log routing recognizes only canonical owner prefixes', () => {
  assert.equal(routeDevTargetLogPaneId('mutagen', new Set(['linux', 'windows'])), 'mutagen');
  assert.equal(routeDevTargetLogPaneId('remote:linux', new Set(['linux', 'windows'])), 'remote-linux');
  assert.equal(routeDevTargetLogPaneId('remote:windows', new Set(['linux', 'windows'])), 'remote-windows');
  assert.equal(routeDevTargetLogPaneId('remote:unknown', new Set(['linux', 'windows'])), null);
  assert.equal(routeDevTargetLogPaneId('daemon', new Set(['linux', 'windows'])), null);
});
