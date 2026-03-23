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
    itemSpy,
    refreshMachinesThrottledSpy,
    revokeSpy,
    routerBackSpy,
    routerMock,
} = vi.hoisted(() => ({
    confirmSpy: vi.fn<(..._args: any[]) => Promise<boolean>>(async () => true),
    itemSpy: vi.fn(),
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
                show: vi.fn(),
            },
        }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSessions: () => [],
            useMachine: () => ({
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
            }),
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
vi.mock('@/sync/domains/server/serverProfiles', () => ({ getActiveServerId: () => 'server-a' }));
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
        confirmSpy.mockReset();
        refreshMachinesThrottledSpy.mockReset();
        revokeSpy.mockReset();
        routerBackSpy.mockReset();
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
});
