import test from 'node:test';
import assert from 'node:assert/strict';

import { stopServiceWithCanonicalCleanup } from './service.mjs';

test('service stop, restart-stop, and disable execute OS destruction inside canonical cleanup ownership', async () => {
  for (const scenario of [
    { platform: 'win32', mode: 'user', disable: true, expected: ['schtasks:/End', 'schtasks:/Change'] },
    { platform: 'darwin', mode: 'user', disable: false, expected: ['launchd'] },
    { platform: 'linux', mode: 'system', disable: true, expected: ['systemctl:disable'] },
    { platform: 'linux', mode: 'user', disable: false, expected: ['systemd-user'] },
  ]) {
    const events = [];
    const env = {
      HAPPIER_STACK_STACK: 'service-owner-test',
      HAPPIER_STACK_STORAGE_DIR: '/tmp/happier-service-owner-test',
    };
    await stopServiceWithCanonicalCleanup({
      rootDir: '/repo',
      mode: scenario.mode,
      persistent: scenario.disable,
      requestedBy: 'service test',
      reason: 'verify ownership',
      disable: scenario.disable,
      platform: scenario.platform,
      env,
      stopStackServiceWithEnvImpl: async (input, stopServiceImpl) => {
        events.push('cleanup-owner-enter');
        assert.equal(input.stopAttribution.requestedBy, 'service test');
        await stopServiceImpl();
        events.push('canonical-cleanup');
      },
      runImpl: async (command, args) => { events.push(`${command}:${args[0]}`); },
      stopLaunchAgentImpl: async () => { events.push('launchd'); },
      systemdStopImpl: async () => { events.push('systemd-user'); },
    });
    assert.equal(events[0], 'cleanup-owner-enter');
    assert.deepEqual(events.slice(1, -1), scenario.expected);
    assert.equal(events.at(-1), 'canonical-cleanup');
  }
});
