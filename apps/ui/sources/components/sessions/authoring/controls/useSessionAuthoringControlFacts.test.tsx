import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMachineFixture, renderHook, standardCleanup } from '@/dev/testkit';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { publishDaemonMergedProjectionInputs } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { getStorage } from '@/sync/domains/state/storageStore';

import { useSessionAuthoringControlFacts } from './useSessionAuthoringControlFacts';

const capabilityState = vi.hoisted(() => ({
    value: { status: 'idle' } as Record<string, unknown>,
}));
const daemonProjection = vi.hoisted(() => ({
    inputs: null as ReturnType<typeof publishDaemonMergedProjectionInputs> | null,
}));

vi.mock('@/hooks/server/useDaemonScopedMachineCapabilitiesCache', () => ({
    useDaemonScopedMachineCapabilitiesCache: () => ({ state: capabilityState.value, refresh: vi.fn() }),
}));
vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => daemonProjection.inputs
        ? { phase: 'ready', inputs: daemonProjection.inputs }
        : { phase: 'loading' },
}));
vi.mock('@/hooks/server/useFeatureEnabled', () => ({ useFeatureEnabled: () => false }));
// The Account's profile read is the network boundary: a cold open waits on it.
vi.mock('@/sync/api/account/apiProfileCatalog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/sync/api/account/apiProfileCatalog')>()),
    readProfileCatalogProjection: () => new Promise(() => {}),
}));
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return { ...createTextModuleMock({ translate: (key) => key }), getPreferredLanguage: () => 'en' };
});

let previous = getStorage().getState();
beforeEach(() => {
    previous = getStorage().getState();
    capabilityState.value = { status: 'idle' };
    daemonProjection.inputs = null;
    const windows = createMachineFixture({ id: 'machine-1' });
    const selected = { ...windows, metadata: { ...windows.metadata!, platform: 'win32', host: 'windows.test' } };
    const otherHome = { ...selected, metadata: { ...selected.metadata, platform: 'linux', host: 'linux.test' } };
    // The exact Home owns this Machine. The focused map deliberately has a
    // same-id row from another Home, so an unscoped fallback cannot pass.
    getStorage().setState({ settingsScope: null, machines: { [otherHome.id]: otherHome },
        machineListByServerId: { 'server-1': [selected], 'server-2': [otherHome] },
        machineListStatusByServerId: { 'server-1': 'idle', 'server-2': 'idle' } });
});
afterEach(async () => {
    await standardCleanup();
    getStorage().setState(previous);
});

describe('useSessionAuthoringControlFacts', () => {
    it('offers only Agents that can enforce workspace denial when a fresh reviewer requires it', async () => {
        const open = { open: ['create'], delivery: ['newTurn'], cancel: true };
        daemonProjection.inputs = publishDaemonMergedProjectionInputs({ projection: PluginProjectionV2Schema.parse({
            v: 2, generation: 1, installedPackagesById: {}, actionsById: {}, familiesById: {},
            resourcesById: {}, settingsById: {}, diagnostics: [],
            agentsById: {
                pi: { id: 'pi', title: 'Pi', capabilities: { sessions: open } },
                codex: { id: 'codex', title: 'Codex', capabilities: { sessions: { ...open, workspaceWrites: 'deny' } } },
            },
        }) });
        const hook = await renderHook(() => {
            const target = { machineId: 'machine-1', serverId: 'server-1', directory: 'C:\\repo' };
            return [
                useSessionAuthoringControlFacts(target),
                useSessionAuthoringControlFacts({ ...target, requireWorkspaceWriteDenial: true }),
            ] as const;
        });
        const [ordinary, restricted] = hook.getCurrent();
        await hook.unmount();
        expect(ordinary.agentTargets?.map(option => option.agentId)).toEqual(expect.arrayContaining(['pi', 'codex']));
        expect(restricted.agentTargets?.map(option => option.agentId)).toEqual(['codex']);
    });

    it('projects the incumbent New Session Windows Terminal capability and fails closed without it', async () => {
        const hook = await renderHook(() => useSessionAuthoringControlFacts({
            machineId: 'machine-1',
            serverId: 'server-1',
            directory: 'C:\\repo',
        }));

        expect(hook.getCurrent().windowsTerminalAvailable).toBe(false);
        expect(hook.getCurrent().machineName).toBe('windows.test');
        expect(hook.getCurrent().targetIsWindows).toBe(true);

        capabilityState.value = {
            status: 'loaded',
            snapshot: {
                response: {
                    protocolVersion: 1,
                    results: {
                        'tool.windowsTerminal': {
                            ok: true,
                            checkedAt: 1,
                            data: { available: true },
                        },
                    },
                },
            },
        };
        await hook.rerender();

        expect(hook.getCurrent().windowsTerminalAvailable).toBe(true);
        await hook.unmount();
    });

    it('reports the Account profile read as loading while it has not answered, never as an empty answer', async () => {
        const read = () => useSessionAuthoringControlFacts({ machineId: 'machine-1', serverId: 'server-1', directory: 'C:\\repo' });

        const noAccount = await renderHook(read);
        expect(noAccount.getCurrent().profilesLoading).toBe(false);
        await noAccount.unmount();

        getStorage().setState({ settingsScope: { serverId: 'server-1', accountId: 'account-1' } });
        const coldOpen = await renderHook(read);
        expect(coldOpen.getCurrent().profiles).toEqual([]);
        expect(coldOpen.getCurrent().profilesLoading).toBe(true);
        await coldOpen.unmount();
        getStorage().setState({ settingsScope: null });
    });
});
