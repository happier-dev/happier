import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { standardCleanup } from '@/dev/testkit';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';

vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
      params: { id: 'pending-page-machine' },
    }).module,
);

const { useMachinePageTarget } = await import('./useMachinePageTarget');

afterEach(() => standardCleanup());

/** A Machine whose row arrived before its details opened: what a cold page holds for a moment. */
function opening(id: string): Machine {
  return {
    ...createMachineFixture({ id, active: true, activeAt: Date.now() }),
    metadata: null,
    daemonState: null,
    daemonStateVersion: 0,
    availability: undefined,
  };
}

function named(id: string, displayName: string): Machine {
  return createMachineFixture({
    id,
    active: true,
    activeAt: Date.now(),
    metadata: {
      ...createMachineFixture().metadata!,
      displayName,
      host: `${id}-host`,
    },
  });
}

// A cold Machine page can hold a Machine's row before its details open. It has no name to show yet, so the page holds the
// name's place instead of showing a placeholder word that a longer name would replace; once the name has been shown it
// stays shown while the details reopen (a reload of the inventory, a reconnect).
it('holds the page name as pending until its details open, and keeps a shown name while they reopen', async () => {
    const store = getStorage();
    const previous = store.getState();
    const serverId = getActiveServerSnapshot().serverId;
    store.getState().applyMachines([opening('pending-page-machine')], true, { sourceServerId: serverId });
    const hook = await renderHook(useMachinePageTarget);
    try {
        expect(hook.getCurrent().namePending).toBe(true);
        const opened = named('pending-page-machine', 'Build box');
        await act(async () => store.getState().applyMachines([opened], true, { sourceServerId: serverId }));
        expect(hook.getCurrent().namePending).toBe(false);
        expect(hook.getCurrent().machineName).toBe(resolveMachineDisplayNames([opened]).get('pending-page-machine'));
        await act(async () => store.getState().applyMachines([opening('pending-page-machine')], true, { sourceServerId: serverId }));
        expect(hook.getCurrent().namePending).toBe(false);
        expect(hook.getCurrent().machineName).toBe('Build box');
    } finally {
        await hook.unmount();
        store.setState(previous);
    }
});
