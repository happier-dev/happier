import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { storage } from '@/sync/domains/state/storageStore';

import { useShouldBlockNewSessionWithGettingStartedGuidance } from './useShouldBlockNewSessionWithGettingStartedGuidance';

const initialState = storage.getState();

afterEach(() => {
    standardCleanup();
    storage.setState(initialState);
});

describe('new-session blocking guidance', () => {
    it('unblocks when a machine arrives through the machine store, including an offline machine', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        storage.getState().applyMachines([], true, { sourceServerId: serverId });
        const hook = await renderHook(() => useShouldBlockNewSessionWithGettingStartedGuidance());
        expect(hook.getCurrent()).toBe(true);

        await act(async () => {
            storage.getState().applyMachines([
                createMachineFixture({ active: false }),
            ], true, { sourceServerId: serverId });
        });
        expect(hook.getCurrent()).toBe(false);

        await act(async () => {
            storage.getState().applyMachines([], true, { sourceServerId: serverId });
        });
        expect(hook.getCurrent()).toBe(true);
    });

    it('keeps an unknown machine list unblocked until an empty list is received', async () => {
        const serverId = getActiveServerSnapshot().serverId;
        storage.setState({ machineListByServerId: {} });
        const hook = await renderHook(() => useShouldBlockNewSessionWithGettingStartedGuidance());
        expect(hook.getCurrent()).toBe(false);

        await act(async () => {
            storage.getState().applyMachines([], true, { sourceServerId: serverId });
        });
        expect(hook.getCurrent()).toBe(true);
    });
});
