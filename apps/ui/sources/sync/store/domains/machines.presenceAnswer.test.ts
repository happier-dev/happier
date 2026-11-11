import { expect, it } from 'vitest';

import { createMachineFixture } from '@/dev/testkit';
import {
  installDisconnectedServerSocketBoundary,
  restoreServerAccountForTest,
} from '@/dev/testkit/harness/serverAccountConnectionHarness';

installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storageStore');
const { subscribeMachineActivity } =
  await import('@/sync/domains/machines/machineActivity');
const { resolveMachineReachability } =
  await import('@/sync/domains/machines/reachability/machineReachability');

// Live 2026-11-11 (Account A, repo-dev): the server listed NLDW6 f759 active, yet its Machine page never showed
// Online and Start session stayed disabled. A fetched census row is the server's own presence answer; only a
// retained warm-cache bit waits for one.
it('a fetched census row answers presence, while a warm-cache bit alone stays pending', async () => {
  const home = 'srv_presence-answer';
  const connection = await restoreServerAccountForTest({
    serverUrl: 'https://presence-answer.test',
    serverIdentityId: home,
  });
  const scope = { serverId: home, accountId: 'account' };
  const options = { sourceServerId: home };
  const now = Date.now();
  const census = createMachineFixture({
    id: 'census',
    active: true,
    activeAt: now,
    presenceProtocolVersion: 1,
  });
  const warm = createMachineFixture({
    id: 'warm',
    active: true,
    activeAt: now,
    presenceProtocolVersion: 1,
  });
  const notified: string[] = [];
  const stops: Array<() => void> = [];
  try {
    storage.getState().replaceMachineDisplays([{ ...warm }], options);
    const warmDisplay = storage.getState().machineDisplayById[warm.id]!;
    stops.push(
      subscribeMachineActivity(warmDisplay, () => notified.push(warm.id)),
    );
    expect(resolveMachineReachability(scope, warmDisplay, now)).toBe('unknown');

    storage.getState().applyMachines([census], false, options);
    const row = storage.getState().machines[census.id]!;
    stops.push(subscribeMachineActivity(row, () => notified.push(census.id)));
    expect(resolveMachineReachability(scope, row, now)).toBe('reachable');
    expect(
      resolveMachineReachability(
        scope,
        storage.getState().machineDisplayById[census.id]!,
        now,
      ),
    ).toBe('reachable');

    // The same census again is not news: no subscriber wakes.
    storage.getState().applyMachines([{ ...census }], false, options);
    expect(notified).toEqual([]);
  } finally {
    stops.forEach((stop) => stop());
    await connection.dispose();
  }
});
