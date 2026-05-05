import test from 'node:test';
import assert from 'node:assert/strict';

import * as stackEnvRunner from './stack/run_script_with_stack_env.mjs';

test('hasRecordedRuntimePortsForRestart requires a positive server port', () => {
  assert.equal(stackEnvRunner.hasRecordedRuntimePortsForRestart(null), false);
  assert.equal(stackEnvRunner.hasRecordedRuntimePortsForRestart({ ports: {} }), false);
  assert.equal(stackEnvRunner.hasRecordedRuntimePortsForRestart({ ports: { server: '0' } }), false);
  assert.equal(stackEnvRunner.hasRecordedRuntimePortsForRestart({ ports: { server: '3010' } }), true);
});

test('shouldReuseRuntimePortsOnRestart reuses runtime ports on stale-owner restarts', () => {
  const runtimeState = { ownerPid: 999_999_999, ports: { server: 3010 } };
  assert.equal(
    stackEnvRunner.shouldReuseRuntimePortsOnRestart({ wantsRestart: true, runtimeState, wasRunning: false }),
    true
  );
});

test('shouldReuseRuntimePortsOnRestart stays false when restart was not requested', () => {
  const runtimeState = { ports: { server: 3010 } };
  assert.equal(
    stackEnvRunner.shouldReuseRuntimePortsOnRestart({ wantsRestart: false, runtimeState, wasRunning: true }),
    false
  );
});

test('buildAlreadyRunningMobileMetroArgs preserves Expo Tailscale mode', () => {
  assert.equal(typeof stackEnvRunner.buildAlreadyRunningMobileMetroArgs, 'function');
  assert.deepEqual(
    stackEnvRunner.buildAlreadyRunningMobileMetroArgs(['--mobile', '--expo-tailscale']),
    ['--metro', '--expo-tailscale']
  );
});

test('inspectExistingStartLikeRuntime treats --expo-tailscale as a mobile request', async () => {
  const result = await stackEnvRunner.inspectExistingStartLikeRuntime({
    scriptPath: 'dev.mjs',
    args: ['--expo-tailscale'],
  });

  assert.equal(result.wantsMobile, true);
});
