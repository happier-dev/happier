import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDevTargetPaneSpecs,
  routeDevTargetLogPaneId,
  routeRemoteServiceLogPaneId,
} from './dev_target_panes.mjs';
import { resolveDevTargetServicePlans } from '../dev_targets/service_placement.mjs';

test('dev target panes add one Mutagen owner and one pane per configured remote worker', () => {
  assert.deepEqual(
    createDevTargetPaneSpecs([{ name: 'linux' }, { name: 'windows' }]),
    [
      { id: 'fabric', title: 'execution fabric', visible: true, kind: 'summary' },
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

test('remote service output routes to the existing service pane only when that service is placed on the target', () => {
  const plans = [
    {
      target: { name: 'mac' },
      services: { server: false, expo: true, daemon: true },
    },
    {
      target: { name: 'linux' },
      services: { server: true, expo: false, daemon: false },
    },
  ];

  assert.equal(routeRemoteServiceLogPaneId('[remote:mac] [expo] Metro waiting', plans), 'expo');
  assert.equal(routeRemoteServiceLogPaneId('[remote:mac] [mobile] Dev client ready', plans), 'expo');
  assert.equal(routeRemoteServiceLogPaneId('[remote:mac] [daemon] connected', plans), 'daemon');
  assert.equal(routeRemoteServiceLogPaneId('[remote:linux] [server] listening', plans), 'server');

  assert.equal(routeRemoteServiceLogPaneId('[remote:mac] [server] probe complete', plans), null);
  assert.equal(routeRemoteServiceLogPaneId('[remote:linux] [expo] mentioned by a command', plans), null);
  assert.equal(routeRemoteServiceLogPaneId('[remote:mac] [local] dependency bootstrap', plans), null);
  assert.equal(routeRemoteServiceLogPaneId('[remote:unknown] [expo] Metro waiting', plans), null);
});

test('pane inputs include command-only targets and exclude targets unused by execution policy', () => {
  const targets = [{ name: 'mac' }, { name: 'windows' }];
  const plans = resolveDevTargetServicePlans({
    targets,
    policy: {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemons: { mode: 'local' },
      commands: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
    },
    requested: { server: true, expo: true, daemon: true },
  });

  assert.deepEqual(
    createDevTargetPaneSpecs(plans.targets.map((plan) => plan.target)),
    [
      { id: 'fabric', title: 'execution fabric', visible: true, kind: 'summary' },
      { id: 'mutagen', title: 'mutagen sync', visible: true, kind: 'log' },
      { id: 'remote-mac', title: 'remote mac', visible: true, kind: 'log' },
    ],
  );
});
