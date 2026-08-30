import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveDevTargetServicePlans,
  resolveServicePlansAfterTargetPreflight,
} from './service_placement.mjs';

const mac = { name: 'mac-host' };

test('authoritative Mac server placement suppresses only the guest server and retains both daemons', () => {
  const plans = resolveDevTargetServicePlans({
    targets: [mac],
    policy: {
      server: { mode: 'prefer-target', target: 'mac-host', fallback: 'local' },
      expo: { mode: 'local' },
      daemons: { mode: 'local-and-targets', targets: ['mac-host'] },
    },
    requested: { server: true, expo: true, daemon: true },
  });

  assert.deepEqual(plans.local, { server: false, expo: true, daemon: true });
  assert.deepEqual(plans.targets, [{
    target: mac,
    services: { server: true, expo: false, daemon: true },
  }]);
});

test('authoritative remote server placement fails closed when its target is unavailable', () => {
  const configured = {
    local: { server: false, expo: true, daemon: true },
    targets: [{ target: mac, services: { server: true, expo: false, daemon: true } }],
  };

  assert.throws(
    () => resolveServicePlansAfterTargetPreflight({
      configured,
      mutagenAvailable: true,
      reachableTargets: new Set(),
    }),
    /persisted server placement is authoritative.*mac-host.*unavailable/i,
  );
});

test('authoritative Mac placement moves the server, Expo, and daemon without local duplicates', () => {
  const plans = resolveDevTargetServicePlans({
    targets: [mac],
    policy: {
      server: { mode: 'prefer-target', target: 'mac-host', fallback: 'local' },
      expo: { mode: 'prefer-target', target: 'mac-host', fallback: 'local' },
      daemons: { mode: 'local-and-targets', targets: ['mac-host'] },
    },
    requested: { server: true, expo: true, daemon: true },
  });

  assert.deepEqual(plans.local, { server: false, expo: false, daemon: true });
  assert.deepEqual(plans.targets, [{
    target: mac,
    services: { server: true, expo: true, daemon: true },
  }]);
});
