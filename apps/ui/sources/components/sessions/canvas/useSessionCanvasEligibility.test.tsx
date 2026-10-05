import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMachineFixture, createSessionFixture, createSessionListRenderableSessionFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { useSessionCanvasEligibility } from './useSessionCanvasEligibility';

describe('useSessionCanvasEligibility', () => {
    let previous: ReturnType<typeof storage.getState>;
    beforeEach(() => {
        previous = storage.getState();
        const machine = createMachineFixture();
        const base = createSessionListRenderableSessionFixture();
        storage.setState({
            sessions: { same: createSessionFixture({ id: 'same', serverId: 'home-a' }) },
            machines: { [machine.id]: machine },
            machineListByServerId: { 'home-b': [machine] },
            sessionListRowsByServerId: { 'home-b': { same: createSessionListRenderableSessionFixture({
                id: 'same', metadata: { ...base.metadata, path: '/qualified-repo' },
            }) } },
        });
    });
    afterEach(() => { standardCleanup(); storage.setState(previous); });

    it('resolves the qualified Home workspace rather than relabeling same-id active Home metadata', async () => {
        const hook = await renderHook(() => useSessionCanvasEligibility('same', { routeServerId: 'home-b' }));
        expect(hook.getCurrent()).toEqual({ isCanvasEligible: true, reason: 'eligible', scope: {
            serverId: 'home-b', machineId: 'machine-1', rootPath: '/qualified-repo',
            workspaceCacheKey: 'home-b:machine-1:/qualified-repo',
        } });
        await hook.unmount();
    });

    it('fails closed when the qualified Home has no workspace evidence', async () => {
        const hook = await renderHook(() => useSessionCanvasEligibility('same', { routeServerId: 'home-c' }));
        expect(hook.getCurrent()).toEqual({ isCanvasEligible: false, reason: 'workspace-unavailable', scope: null });
        await hook.unmount();
    });
});
