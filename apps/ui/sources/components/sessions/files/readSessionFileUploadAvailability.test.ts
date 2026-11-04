import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { storage } from '@/sync/domains/state/storageStore';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { disposeTransferFixture, installTransferProjection, resetTransferFixture, transferMachine } from './sessionFileTransferTestkit';
import { readSessionFileUploadAvailability } from './readSessionFileUploadAvailability';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

beforeEach(async () => {
    vi.stubGlobal('SharedWorker', class SharedWorker {});
    await resetTransferFixture();
    await loadSyncSingletonForTests();
});
afterEach(async () => { await disposeTransferFixture(); vi.unstubAllGlobals(); });

describe('readSessionFileUploadAvailability', () => {
    it('reads the same current Machine carrier as composer upload availability', async () => {
        installTransferProjection();
        let globalInventoryEnumerations = 0;
        const unrelatedMachines = Object.fromEntries(Array.from({ length: 150 }, (_, index) => {
            const machine = transferMachine({ id: `unrelated-${index}` });
            return [machine.id, machine];
        }));
        storage.setState({ machines: new Proxy(unrelatedMachines, {
            ownKeys(target) { globalInventoryEnumerations += 1; return Reflect.ownKeys(target); },
        }) });
        storage.setState({ sessionListRowsByServerId: { 'server-1': { s1: createSessionListRenderableSessionFixture({
            id: 's1', active: true, metadata: { machineId: 'machine-1', path: '/repo' },
        }) } } });
        await expect(readSessionFileUploadAvailability({ serverId: 'server-1', sessionId: 's1' }))
            .resolves.toEqual({ uploadAvailable: true, machineReachability: 'reachable' });
        expect(globalInventoryEnumerations).toBe(0);
    });

    it('keeps an offline target unavailable without borrowing a same-id Machine from another Home', async () => {
        const offline = transferMachine({ active: false });
        installTransferProjection({ machine: offline, globalMachine: transferMachine() });
        storage.setState({ sessionListRowsByServerId: { 'server-1': { s1: createSessionListRenderableSessionFixture({
            id: 's1', active: false, metadata: { machineId: 'machine-1', path: '/repo' },
        }) }, 'server-b': { s1: createSessionListRenderableSessionFixture({ id: 's1', active: true,
            metadata: { machineId: 'machine-1', path: '/repo' } }) } } });
        await expect(readSessionFileUploadAvailability({ serverId: 'server-1', sessionId: 's1' }))
            .resolves.toEqual({ uploadAvailable: false, machineReachability: 'unreachable' });
        await expect(readSessionFileUploadAvailability({ serverId: 'server-b', sessionId: 's1' }))
            .resolves.toEqual({ uploadAvailable: false, machineReachability: 'unknown' });
    });

    it('does not accept an active same-id Session on a different Home', async () => {
        installTransferProjection({ session: createSessionFixture({ id: 's1', serverId: 'server-b', active: true,
            metadata: { machineId: 'machine-1', path: '/repo', host: 'tester.local' } }) });
        await expect(readSessionFileUploadAvailability({ serverId: 'server-1', sessionId: 's1' }))
            .resolves.toMatchObject({ uploadAvailable: false });
    });
});
