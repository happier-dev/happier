import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMachineFixture, createSessionFixture, renderHook } from '@/dev/testkit';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { storage } from '@/sync/domains/state/storageStore';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

await import('@/sync/syncEngine');
const { useSessionMachineTarget } = await import('./useSessionMachineTarget');
const initialState = storage.getState();
afterEach(() => storage.setState(initialState, true));

describe('Session machine target binding', () => {
    it('uses the captured Home instead of a same-id active Session', async () => {
        const machineA = createMachineFixture({ id: 'machine-a', active: true });
        const machineB = createMachineFixture({ id: 'machine-b', active: true });
        const sessionA = createSessionFixture({ id: 'same-session', serverId: 'home-a', active: true, metadata: { machineId: 'machine-a', path: '/a', host: 'host-a' } });
        const sessionB = createSessionFixture({ id: 'same-session', serverId: 'home-b', active: true, metadata: { machineId: 'machine-b', path: '/b', host: 'host-b' } });
        storage.setState({ machineListByServerId: { 'home-a': [machineA], 'home-b': [machineB] }, sessions: { 'same-session': sessionA }, machines: { 'machine-a': machineA, 'machine-b': machineB },
            sessionListRowsByServerId: { 'home-a': { 'same-session': buildSessionListRenderableFromSession(sessionA) }, 'home-b': { 'same-session': buildSessionListRenderableFromSession(sessionB) } } });
        // Existing canonical resolver accepts this identity; the hook must preserve it.
        const target = { serverId: 'home-b', sessionId: 'same-session' };
        const hook = await renderHook(() => useSessionMachineTarget(target));
        expect(hook.getCurrent()).toMatchObject({ machineId: 'machine-b', basePath: '/b' });
        await hook.unmount();
    });
});
