import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createMachineFixture, createSessionFixture, renderHook } from '@/dev/testkit';
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

    it('does not re-render its reader for a target machine heartbeat that leaves the target unchanged', async () => {
        const machine = createMachineFixture({ id: 'machine-a', active: true, activeAt: 1_000, metadata: { ...createMachineFixture().metadata!, host: 'host-a', homeDir: '/home/a' } });
        const session = createSessionFixture({ id: 'session-a', serverId: 'home-a', active: true, metadata: { machineId: 'machine-a', path: '/a', host: 'host-a', homeDir: '/home/a' } });
        storage.setState({ machineListByServerId: { 'home-a': [machine] }, sessions: { 'session-a': session }, machines: { 'machine-a': machine },
            sessionListRowsByServerId: { 'home-a': { 'session-a': buildSessionListRenderableFromSession(session) } } });
        const target = { serverId: 'home-a', sessionId: 'session-a' };
        let renders = 0;
        const hook = await renderHook(() => { renders += 1; return useSessionMachineTarget(target); });
        const settled = hook.getCurrent();
        expect(settled).toMatchObject({ machineId: 'machine-a', basePath: '/a' });
        const rendersBefore = renders;
        // A daemon heartbeat: new daemon state, version and timestamps on the same live machine.
        for (let beat = 1; beat <= 3; beat++) {
            const next = { ...machine, activeAt: 1_000 + beat, updatedAt: 1_000 + beat, daemonStateVersion: 1 + beat,
                daemonState: { pid: 100 + beat } as unknown as typeof machine.daemonState };
            await act(async () => {
                storage.setState({ machines: { 'machine-a': next }, machineListByServerId: { 'home-a': [next] } });
            });
        }
        expect(renders - rendersBefore).toBe(0);
        expect(hook.getCurrent()).toBe(settled);
        await hook.unmount();
    });

    it('keeps the target object when switching to a Session with the same machine target', async () => {
        const machine = createMachineFixture({ id: 'machine-a', active: true });
        const sessions = ['session-a', 'session-b'].map(id => createSessionFixture({ id, serverId: 'home-a', active: true,
            metadata: { machineId: 'machine-a', path: '/repo', host: 'host-a' } }));
        storage.setState({ machineListByServerId: { 'home-a': [machine] }, machines: { 'machine-a': machine },
            sessions: Object.fromEntries(sessions.map(session => [session.id, session])),
            sessionListRowsByServerId: { 'home-a': Object.fromEntries(sessions.map(session => [session.id, buildSessionListRenderableFromSession(session)])) } });
        const targets = { a: { serverId: 'home-a', sessionId: 'session-a' }, b: { serverId: 'home-a', sessionId: 'session-b' } };
        const hook = await renderHook((key: 'a' | 'b') => useSessionMachineTarget(targets[key]), { initialProps: 'a' });
        const first = hook.getCurrent();
        expect(first).toMatchObject({ machineId: 'machine-a', basePath: '/repo' });
        await hook.rerender('b');
        expect(hook.getCurrent()).toBe(first);
        await hook.unmount();
    });
});
