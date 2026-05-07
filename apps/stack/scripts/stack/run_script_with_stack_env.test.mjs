import test from 'node:test';
import assert from 'node:assert/strict';

test('buildAlreadyRunningMobileMetroArgs preserves Expo Tailscale mode', async () => {
  const mod = await import('./run_script_with_stack_env.mjs');

  assert.equal(typeof mod.buildAlreadyRunningMobileMetroArgs, 'function');
  assert.deepEqual(
    mod.buildAlreadyRunningMobileMetroArgs(['--mobile', '--expo-tailscale']),
    ['--metro', '--expo-tailscale']
  );
});
