import { afterEach, describe, expect, it, vi } from 'vitest';

import { act, createMachineFixture, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const { useSessionPlacementCandidateRows } = await import('./useSessionPlacementCandidateRows');

describe('useSessionPlacementCandidateRows', () => {
    afterEach(standardCleanup);

    it('names a Machine as soon as its list answers, and an unrelated publication changes nothing', async () => {
        const previous = storage.getState();
        const serverId = 'server-1';
        const machine = createMachineFixture({ id: 'machine-1', activeAt: Date.now(),
            metadata: { host: 'studio', platform: 'darwin', happyCliVersion: '1', happyHomeDir: '/h/.happier', homeDir: '/h', displayName: 'Studio' } });
        const candidates = [{ projectKey: { id: 'app' }, serverId, machineId: machine.id, rootPath: '/h/app', reachable: true, worktrees: [] }];
        let renders = 0;
        try {
            await act(async () => { storage.setState({ machineListByServerId: { [serverId]: [] }, machineListStatusByServerId: { [serverId]: 'loading' } }); });
            const hook = await renderHook(() => { renders += 1; return useSessionPlacementCandidateRows(candidates); });
            expect(hook.getCurrent()[0]).toMatchObject({ title: 'app', availability: 'unknown' });
            await act(async () => { storage.setState({ machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } }); });
            await flushHookEffects();
            expect(hook.getCurrent()[0]?.subtitle).toContain('Studio');
            const settled = hook.getCurrent();
            const settledRenders = renders;
            await act(async () => { storage.setState({ machineListStatusByServerId: { [serverId]: 'idle', other: 'idle' } }); });
            await flushHookEffects();
            expect(hook.getCurrent()).toBe(settled);
            expect(renders).toBe(settledRenders);
        } finally { storage.setState(previous); }
    });

    it('reads nothing without candidates and returns one stable empty list', async () => {
        const hook = await renderHook(() => useSessionPlacementCandidateRows(undefined));
        const first = hook.getCurrent();
        expect(first).toEqual([]);
        await act(async () => { storage.setState({ machineListStatusByServerId: { unrelated: 'loading' } }); });
        expect(hook.getCurrent()).toBe(first);
    });
});
