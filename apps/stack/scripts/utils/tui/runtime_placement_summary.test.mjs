import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatRuntimeExpoDevClientLines,
  formatRuntimePlacementSummaryLines,
  shouldPresentRuntimeServiceEndpoint,
  resolveRuntimeRemoteServiceObservation,
} from './runtime_placement_summary.mjs';

test('runtime placement observation recognizes a running target-hosted daemon without a local pid', () => {
  assert.deepEqual(resolveRuntimeRemoteServiceObservation({
    placement: { server: 'local', expo: 'mac', daemon: 'mac' },
    remoteTargets: {
      mac: {
        services: { server: false, expo: true, daemon: true },
        status: 'running',
      },
    },
  }, 'daemon'), {
    target: 'mac',
    running: true,
    status: 'running',
  });
});

test('runtime placement observes each remote service independently', () => {
  const runtime = {
    placement: { server: 'local', expo: 'mac', daemon: 'mac' },
    remoteTargets: {
      mac: {
        services: { server: false, expo: true, daemon: true },
        serviceStatus: { expo: 'running', daemon: 'degraded' },
        status: 'degraded',
      },
    },
  };

  assert.deepEqual(resolveRuntimeRemoteServiceObservation(runtime, 'expo'), {
    target: 'mac',
    running: true,
    status: 'running',
  });
  assert.deepEqual(resolveRuntimeRemoteServiceObservation(runtime, 'daemon'), {
    target: 'mac',
    running: false,
    status: 'degraded',
  });
});

test('runtime placement summary reports local tunnel ownership without inventing remote pids', () => {
  assert.deepEqual(formatRuntimePlacementSummaryLines({
    placement: { server: 'local', expo: 'mac', daemon: 'mac' },
    remoteTargets: {
      mac: {
        commands: true,
        services: { server: false, expo: true, daemon: true },
        status: 'running',
      },
    },
  }), [
    'placement:',
    '  server: local',
    '  expo: mac',
    '  daemon: mac',
    'remote targets:',
    '  mac: running (expo, daemon, commands)',
  ]);
});

test('runtime placement summary includes retry phase and error without requiring service process ids', () => {
  assert.deepEqual(formatRuntimePlacementSummaryLines({
    placement: { expo: 'mac' },
    remoteTargets: {
      mac: {
        services: { expo: true },
        status: 'retrying',
        phase: 'worker',
        error: 'remote worker exited',
      },
    },
  }), [
    'placement:',
    '  expo: mac',
    'remote targets:',
    '  mac: retrying (expo) phase=worker error=remote worker exited',
  ]);
});

test('remote Expo links and QR stay pending until the target reports Metro readiness', () => {
  const startingRuntime = {
    placement: { expo: 'mac' },
    remoteTargets: {
      mac: {
        services: { expo: true },
        status: 'starting',
        phase: 'stop',
      },
    },
  };
  const payload = {
    scheme: 'happier-dev',
    metroUrl: 'http://localhost:19364',
    deepLink: 'happier-dev://expo-development-client/?url=ready-only',
  };

  assert.equal(shouldPresentRuntimeServiceEndpoint(startingRuntime, 'expo'), false);
  assert.deepEqual(formatRuntimeExpoDevClientLines(startingRuntime, payload), [
    'expo dev-client:',
    '  pending: mac status=starting phase=stop',
  ]);

  const runningRuntime = {
    ...startingRuntime,
    remoteTargets: {
      mac: {
        services: { expo: true },
        status: 'running',
        phase: null,
      },
    },
  };
  assert.equal(shouldPresentRuntimeServiceEndpoint(runningRuntime, 'expo'), true);
  assert.deepEqual(formatRuntimeExpoDevClientLines(runningRuntime, payload), [
    'expo dev-client links:',
    '  metro: http://localhost:19364',
    '  link:  happier-dev://expo-development-client/?url=ready-only',
  ]);
  assert.equal(shouldPresentRuntimeServiceEndpoint({ placement: { expo: 'local' } }, 'expo'), true);
});
