import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveDevTargetServicePlans,
  resolveServicePlansAfterTargetPreflight,
} from './service_placement.mjs';

const targets = [{ name: 'mac' }, { name: 'windows' }];

test('v2 placement assigns server, Expo, and daemon services without starting local duplicates', () => {
  const plans = resolveDevTargetServicePlans({
    targets,
    policy: {
      server: { mode: 'local' },
      expo: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
      daemons: { mode: 'prefer-target', target: 'windows', fallback: 'local' },
      commands: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
    },
    requested: { server: true, expo: true, daemon: true },
  });

  assert.deepEqual(plans.local, { server: true, expo: false, daemon: false });
  assert.deepEqual(plans.targets, [
    { target: targets[0], commands: true, services: { server: false, expo: true, daemon: false } },
    { target: targets[1], commands: false, services: { server: false, expo: false, daemon: true } },
  ]);
});

test('command execution alone owns synchronization for its target without adding a runtime service', () => {
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

  assert.deepEqual(plans.local, { server: true, expo: true, daemon: true });
  assert.deepEqual(plans.targets, [
    { target: targets[0], commands: true, services: { server: false, expo: false, daemon: false } },
  ]);
});

test('automatic command execution keeps every selected target synchronized without adding services', () => {
  const plans = resolveDevTargetServicePlans({
    targets,
    policy: {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemons: { mode: 'local' },
      commands: {
        mode: 'auto',
        targets: ['mac', 'windows'],
        includeLocal: false,
        fallback: 'local',
        loadProbeTtlMs: 15_000,
        unavailableProbeTtlMs: 120_000,
      },
    },
    requested: { server: true, expo: true, daemon: true },
  });

  assert.deepEqual(plans.local, { server: true, expo: true, daemon: true });
  assert.deepEqual(plans.targets, [
    { target: targets[0], commands: true, services: { server: false, expo: false, daemon: false } },
    { target: targets[1], commands: true, services: { server: false, expo: false, daemon: false } },
  ]);
});

test('version 1 compatibility runs local services plus a daemon on every target', () => {
  const plans = resolveDevTargetServicePlans({
    targets,
    policy: {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemons: { mode: 'local-and-targets', targets: ['mac', 'windows'] },
      commands: { mode: 'local' },
    },
    requested: { server: true, expo: true, daemon: true },
  });
  assert.deepEqual(plans.local, { server: true, expo: true, daemon: true });
  assert.ok(plans.targets.every((plan) => plan.services.daemon));
});

test('host preflight failure selects local fallback without removing reachable or locally-backed target services', () => {
  const configured = resolveDevTargetServicePlans({
    targets,
    policy: {
      server: { mode: 'local' },
      expo: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
      daemons: { mode: 'local-and-targets', targets: ['mac', 'windows'] },
      commands: { mode: 'local' },
    },
    requested: { server: true, expo: true, daemon: true },
  });
  const resolved = resolveServicePlansAfterTargetPreflight({
    configured,
    mutagenAvailable: true,
    reachableTargets: new Set(['windows']),
  });

  assert.deepEqual(resolved.local, { server: true, expo: true, daemon: true });
  assert.deepEqual(resolved.targets, [
    { target: targets[0], commands: false, services: { server: false, expo: false, daemon: true } },
    { target: targets[1], commands: false, services: { server: false, expo: false, daemon: true } },
  ]);
  assert.deepEqual(resolved.fallbacks, [
    { target: 'mac', services: ['expo'], reason: 'target-unreachable' },
  ]);
});

test('host preflight fallback retains command synchronization while moving unavailable services local', () => {
  const configured = resolveDevTargetServicePlans({
    targets,
    policy: {
      server: { mode: 'local' },
      expo: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
      daemons: { mode: 'local' },
      commands: { mode: 'prefer-target', target: 'mac', fallback: 'local' },
    },
    requested: { server: true, expo: true, daemon: true },
  });
  const resolved = resolveServicePlansAfterTargetPreflight({
    configured,
    mutagenAvailable: true,
    reachableTargets: new Set(),
  });

  assert.deepEqual(resolved.local, { server: true, expo: true, daemon: true });
  assert.deepEqual(resolved.targets, [
    { target: targets[0], commands: true, services: { server: false, expo: false, daemon: false } },
  ]);
});
