import * as React from 'react';
import { act } from 'react-test-renderer';
import { expect, it } from 'vitest';

import { createMachineFixture, createRenderCommitCounter, renderScreen, useRenderCommitCounter } from '@/dev/testkit';
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


it('answers a warm-matching census once and renders only rows whose presence becomes known', async () => {
  const home = 'srv_warm-matching-answer';
  const connection = await restoreServerAccountForTest({
    serverUrl: 'https://warm-matching-answer.test', serverIdentityId: home,
  });
  const scope = { serverId: home, accountId: 'account' };
  const options = { sourceServerId: home };
  const now = Date.now();
  // The reported cold Usage load held 24 retained active Machines.
  const census = Array.from({ length: 24 }, (_, index) => createMachineFixture({
    id: `warm-matching-${index}`, active: true, activeAt: now, presenceProtocolVersion: 1,
  }));
  const { useMachinePresenceSnapshot } = await import('@/sync/domains/machines/reachability/useMachinePresenceSummary');
  const counters = census.map(() => createRenderCommitCounter());
  const verdicts = new Map<string, ReturnType<typeof resolveMachineReachability>>();
  storage.getState().replaceMachineDisplays(census.map(machine => ({ ...machine })), options);
  const displays = census.map(machine => storage.getState().machineDisplayById[machine.id]!);
  function Row({ index }: Readonly<{ index: number }>) {
    const display = displays[index]!;
    const readMachines = React.useCallback(() => [display], [display]);
    const readSnapshot = React.useCallback((nowMs: number) => resolveMachineReachability(scope, display, nowMs), [display]);
    const targets = React.useMemo(() => [{ serverId: home, machineIds: [display.id] }], [display]);
    const presence = useMachinePresenceSnapshot(readMachines, readSnapshot, targets);
    useRenderCommitCounter(counters[index]!);
    verdicts.set(display.id, presence);
    return React.createElement('row', { machineId: display.id, presence });
  }
  const screen = await renderScreen(React.createElement(React.Fragment, null,
    ...census.map((machine, index) => React.createElement(Row, { key: machine.id, index }))));
  try {
    expect([...verdicts.values()]).toEqual(census.map(() => 'unknown'));
    counters.forEach(counter => counter.reset());

    // Same id and equal active/activeAt: knowing the answer is the changed fact.
    await act(async () => storage.getState().applyMachines([{ ...census[0]! }], false, options));
    expect(verdicts.get(census[0]!.id)).toBe('reachable');
    expect([...verdicts.values()].filter(value => value === 'reachable')).toHaveLength(1);
    expect(counters.map(counter => counter.read())).toEqual(census.map((_, index) =>
      ({ renders: index === 0 ? 1 : 0, commits: index === 0 ? 1 : 0 })));

    counters.forEach(counter => counter.reset());
    await act(async () => storage.getState().applyMachines([{ ...census[0]! }], false, options));
    expect(counters.map(counter => counter.read())).toEqual(census.map(() => ({ renders: 0, commits: 0 })));

    await act(async () => storage.getState().applyMachines(census.slice(1).map(machine => ({ ...machine })), false, options));
    expect([...verdicts.values()]).toEqual(census.map(() => 'reachable'));
    expect(counters.map(counter => counter.read())).toEqual(census.map((_, index) =>
      ({ renders: index === 0 ? 0 : 1, commits: index === 0 ? 0 : 1 })));
  } finally {
    await screen.unmount();
    await connection.dispose();
  }
});
