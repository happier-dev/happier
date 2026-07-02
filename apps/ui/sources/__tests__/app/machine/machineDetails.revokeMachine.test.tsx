import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installMachineDetailsCommonModuleMocks } from './machineDetailsTestHelpers';

const testGlobal = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    expo?: { EventEmitter: new () => unknown };
};

testGlobal.IS_REACT_ACT_ENVIRONMENT = true;
testGlobal.expo = { EventEmitter: class {} } as unknown as NonNullable<typeof testGlobal.expo>;

const {
    confirmSpy,
    showSpy,
    itemSpy,
    machineState,
    clearReplacementSpy,
    replaceSpy,
    refreshMachinesThrottledSpy,
    revokeSpy,
    routerBackSpy,
    routerMock,
} = vi.hoisted(() => ({
    confirmSpy: vi.fn<(..._args: any[]) => Promise<boolean>>(async () => true),
    showSpy: vi.fn<(..._args: any[]) => string>(() => 'replacement-picker-modal'),
    itemSpy: vi.fn(),
    machineState: {
        currentMachine: null as any,
        machinesByServerId: {} as Record<string, any[] | null>,
    },
    clearReplacementSpy: vi.fn(async (_machineId: string) => ({ ok: true as const })),
    replaceSpy: vi.fn(async (_params: any) => ({ ok: true as const })),
    refreshMachinesThrottledSpy: vi.fn(async () => {}),
    revokeSpy: vi.fn(async (_machineId: string) => ({ ok: true as const })),
    routerBackSpy: vi.fn(),
    routerMock: { back: vi.fn(), push: vi.fn(), replace: vi.fn() },
}));

installMachineDetailsCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { ...routerMock, back: routerBackSpy },
            params: { id: 'machine-1' },
        }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: confirmSpy,
                prompt: vi.fn(),
                show: showSpy,
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSessions: () => [],
            useMachine: () => machineState.currentMachine,
            useMachineListByServerId: () => machineState.machinesByServerId,
            useSetting: () => false,
            useSettingMutable: () => [null, vi.fn()],
            useSettings: () => ({}),
            storage: {
                getState: () => ({
                    settings: {},
                    sessions: {},
                    machines: {},
                    getProjectForSession: () => null,
                }),
            },
        });
    },
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => {
        itemSpy(props);
        return React.createElement(React.Fragment, null);
    },
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));
vi.mock('@/components/ui/lists/ItemGroupTitleWithAction', () => ({ ItemGroupTitleWithAction: () => null }));
vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children) }));
vi.mock('@/components/ui/forms/MultiTextInput', () => ({ MultiTextInput: () => null }));
vi.mock('@/components/ui/pathBrowser/PathInputBrowseButton', () => ({
    PathInputBrowseButton: () => null,
}));
vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: vi.fn(async () => null),
}));
vi.mock('@/components/machines/DetectedClisList', () => ({ DetectedClisList: () => null }));
vi.mock('@/components/ui/forms/Switch', () => ({ Switch: () => null }));
vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));
vi.mock('@/components/machines/InstallableDepInstaller', () => ({ InstallableDepInstaller: () => null }));
vi.mock('@/components/sessions/runs/ExecutionRunRow', () => ({ ExecutionRunRow: () => null }));

vi.mock('@/sync/ops', () => ({
    machineSpawnNewSession: vi.fn(async () => ({ type: 'error', errorCode: 'unexpected', errorMessage: 'noop' })),
    machineStopDaemon: vi.fn(async () => ({ message: 'noop' })),
    machineStopSession: vi.fn(async () => ({ ok: true })),
    machineUpdateMetadata: vi.fn(async () => ({})),
    machineExecutionRunsList: vi.fn(async () => ({ ok: true, runs: [] })),
    machineClearReplacementFromAccount: clearReplacementSpy,
    machineReplaceInAccount: replaceSpy,
    machineRevokeFromAccount: revokeSpy,
}));

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStop: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => () => {} }));
vi.mock('@/hooks/ui/useMountedShouldContinue', () => ({
    useMountedShouldContinue: () => () => true,
}));
vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({ useMachineCapabilitiesCache: () => ({ state: { status: 'idle' }, refresh: vi.fn() }) }));
vi.mock('@/sync/domains/server/serverProfiles', () => ({
    areServerProfileIdentifiersEquivalent: (left: unknown, right: unknown) => String(left ?? '').trim() === String(right ?? '').trim(),
    getActiveServerId: () => 'server-a',
}));
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({ setActiveServerAndSwitch: vi.fn(async () => true) }));
vi.mock('@/sync/sync', () => ({ sync: { refreshMachinesThrottled: refreshMachinesThrottledSpy, refreshMachines: vi.fn(), retryNow: vi.fn() } }));
vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: Promise<unknown>, options?: { onError?: (error: unknown) => void }) => {
        void promise.catch((error) => {
            options?.onError?.(error);
        });
    },
}));
vi.mock('@/utils/errors/daemonUnavailableAlert', () => ({
    tryShowDaemonUnavailableAlertForRpcError: () => false,
    tryShowDaemonUnavailableAlertForRpcFailure: () => false,
}));
vi.mock('@/utils/sessions/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/utils/sessions/sessionUtils', () => ({ formatPathRelativeToHome: () => '', getSessionName: () => '', getSessionSubtitle: () => '' }));
vi.mock('@/utils/path/pathUtils', () => ({ resolveAbsolutePath: () => '' }));
vi.mock('@/sync/domains/settings/terminalSettings', () => ({ resolveTerminalSpawnOptions: () => ({}) }));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionConsole', () => ({ resolveWindowsRemoteSessionConsoleFromMachineMetadata: () => 'visible' }));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode', () => ({
    readMachineWindowsRemoteSessionLaunchMode: () => undefined,
    resolveEffectiveWindowsRemoteSessionLaunchMode: () => ({ mode: 'visible' }),
}));
vi.mock('@/capabilities/installablesRegistry', () => ({ getInstallablesRegistryEntries: () => [] }));
vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex'],
    DEFAULT_AGENT_ID: 'codex',
    getAgentCore: () => ({ cli: { detectKey: 'codex' } }),
    isAgentId: () => true,
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: () => null,
}));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchModeOptions', () => ({
    WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS: [],
}));
vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: () => null,
}));

describe('MachineDetailScreen (revoke/forget machine)', () => {
    beforeEach(() => {
        itemSpy.mockReset();
        showSpy.mockReset();
        confirmSpy.mockReset();
        clearReplacementSpy.mockReset();
        replaceSpy.mockReset();
        refreshMachinesThrottledSpy.mockReset();
        revokeSpy.mockReset();
        routerBackSpy.mockReset();
        machineState.currentMachine = {
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 0,
            metadata: { displayName: 'My Machine', host: 'host', platform: 'darwin' },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
            revokedAt: null,
        };
        machineState.machinesByServerId = {
            'server-a': [
                machineState.currentMachine,
                {
                    id: 'machine-2',
                    active: true,
                    activeAt: Date.now(),
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    seq: 0,
                    metadata: { displayName: 'Replacement Machine', host: 'replacement', platform: 'darwin' },
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                    revokedAt: null,
                    spawnReadinessStatus: 'ready',
                },
            ],
        };
    });

    it('confirms and revokes the machine', async () => {
        confirmSpy.mockResolvedValueOnce(true);

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        await renderScreen(React.createElement(MachineDetailScreen));

        const removeItem = itemSpy.mock.calls
            .map(([props]) => props)
            .find((props) => props?.title === 'machine.actions.removeMachine');
        expect(removeItem).toBeTruthy();
        expect(typeof removeItem.onPress).toBe('function');

        await act(async () => {
            await removeItem.onPress();
        });

        expect(confirmSpy).toHaveBeenCalled();
        expect(revokeSpy).toHaveBeenCalledWith('machine-1');
        expect(refreshMachinesThrottledSpy).toHaveBeenCalled();
        expect(routerBackSpy).toHaveBeenCalled();
    });

    it('renders one replacement repair action that opens a candidate picker', async () => {
        machineState.machinesByServerId = {
            'server-a': [
                machineState.currentMachine,
                ...Array.from({ length: 5 }, (_, index) => ({
                    id: `machine-${index + 2}`,
                    active: index === 0,
                    activeAt: Date.now() - index,
                    createdAt: Date.now(),
                    updatedAt: Date.now(),
                    seq: 0,
                    metadata: { displayName: index % 2 === 0 ? 'leeroy-mbp' : 'L-C-005', host: 'replacement', platform: 'darwin' },
                    metadataVersion: 1,
                    daemonState: null,
                    daemonStateVersion: 0,
                    revokedAt: null,
                })),
            ],
        };

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        await renderScreen(React.createElement(MachineDetailScreen));

        const replacementItems = itemSpy.mock.calls
            .map(([props]) => props)
            .filter((props) => String(props?.testID ?? '').startsWith('machine-replacement-repair'));
        expect([...new Set(replacementItems.map((item) => item.testID))]).toEqual(['machine-replacement-repair-open']);

        const replacementItem = replacementItems[0];
        expect(replacementItem).toBeTruthy();
        expect(replacementItem.detail).toBeUndefined();
        expect(replacementItem.detailTestID).toBeUndefined();

        await act(async () => {
            await replacementItem.onPress();
        });

        expect(showSpy).toHaveBeenCalledTimes(1);
        const showOptions = showSpy.mock.calls[0]?.[0];
        expect(showOptions).toMatchObject({
            props: expect.objectContaining({
                onSelectCandidate: expect.any(Function),
            }),
            chrome: expect.objectContaining({
                testID: 'machine-replacement-picker-modal',
                scrollHost: 'body',
            }),
        });
        expect(showOptions?.chrome).not.toHaveProperty('layout');
        expect(showOptions?.props?.candidates).toHaveLength(5);
        expect(replaceSpy).not.toHaveBeenCalled();
    });

    it('opens the replacement picker with candidates regardless of spawn readiness', async () => {
        machineState.machinesByServerId['server-a'] = machineState.machinesByServerId['server-a']!.map((machine) =>
            machine.id === 'machine-2'
                ? { ...machine, active: false, activeAt: 0, spawnReadinessStatus: 'unknown' }
                : machine,
        );
        machineState.machinesByServerId['server-loading'] = null;

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        await renderScreen(React.createElement(MachineDetailScreen));

        const replacementItem = itemSpy.mock.calls
            .map(([props]) => props)
            .find((props) => props?.testID === 'machine-replacement-repair-open');
        expect(replacementItem).toBeTruthy();
        expect(replacementItem.detail).toBeUndefined();

        await act(async () => {
            await replacementItem.onPress();
        });

        expect(showSpy.mock.calls[0]?.[0]?.props?.candidates).toEqual([
            expect.objectContaining({ id: 'machine-2' }),
        ]);
    });

    it('selects a replacement candidate from the picker', async () => {
        confirmSpy.mockResolvedValueOnce(true);

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        await renderScreen(React.createElement(MachineDetailScreen));

        const replacementItem = itemSpy.mock.calls
            .map(([props]) => props)
            .find((props) => props?.testID === 'machine-replacement-repair-open');
        expect(replacementItem).toBeTruthy();

        await act(async () => {
            await replacementItem.onPress();
            await showSpy.mock.calls[0]?.[0]?.props?.onSelectCandidate('machine-2', 'Replacement Machine');
        });

        expect(confirmSpy).toHaveBeenCalled();
        expect(replaceSpy).toHaveBeenCalledWith({
            oldMachineId: 'machine-1',
            replacementMachineId: 'machine-2',
            confirmActiveOldMachine: true,
        });
        expect(refreshMachinesThrottledSpy).toHaveBeenCalled();
    });

    it('clears an existing explicit replacement relation', async () => {
        confirmSpy.mockResolvedValueOnce(true);
        machineState.currentMachine = {
            ...machineState.currentMachine,
            replacedByMachineId: 'machine-2',
        };

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        await renderScreen(React.createElement(MachineDetailScreen));

        const undoItem = itemSpy.mock.calls
            .map(([props]) => props)
            .find((props) => props?.testID === 'machine-replacement-repair-undo');
        expect(undoItem).toBeTruthy();

        await act(async () => {
            await undoItem.onPress();
        });

        expect(confirmSpy).toHaveBeenCalled();
        expect(clearReplacementSpy).toHaveBeenCalledWith('machine-1');
        expect(refreshMachinesThrottledSpy).toHaveBeenCalled();
    });
});
