import { act } from 'react-test-renderer';
import { expect, it } from 'vitest';

import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { getStorage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';

import { useExternalSessionSharingAvailability } from './useExternalSessionSharingAvailability';

// The Session collaboration pane reads one Session's sharing facts; the rest of the Home's fleet is not an input.
it.each([3, 30])('does no work while %s unrelated Machines of the Home open their content', async (others) => {
    const store = getStorage();
    const previous = store.getState();
    const serverId = getActiveServerSnapshot().serverId;
    const fleet = Array.from({ length: others }, (_, index) => createMachineFixture({ id: `fleet-${index}`, metadata: null, daemonStateVersion: 3 }));
    store.getState().applyMachines(fleet, true, { sourceServerId: serverId });
    store.getState().markMachineListSettled(serverId);
    let renders = 0;
    const hook = await renderHook(() => {
        renders += 1;
        return useExternalSessionSharingAvailability({ serverId, sessionId: 'session-1', session: null, accountScopeKey: null });
    });
    try {
        renders = 0;
        for (const machine of fleet) {
            await act(async () => store.getState().applyMachines([{ ...machine, metadataVersion: 2, daemonStateVersion: 4,
                metadata: { ...createMachineFixture().metadata!, displayName: `Opened ${machine.id}` } }], false, { sourceServerId: serverId }));
        }
        expect(renders).toBe(0);
    } finally {
        await hook.unmount();
        store.setState(previous);
    }
});
