import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installMachineDetailsCommonModuleMocks } from './machineDetailsTestHelpers';


type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    expo?: unknown;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class {} };

const { requests } = vi.hoisted(() => ({
    requests: [] as Array<Record<string, unknown>>,
}));
const modalSpies = vi.hoisted(() => ({
    alert: vi.fn(),
    confirm: vi.fn(),
    prompt: vi.fn(),
    show: vi.fn(),
}));

installMachineDetailsCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({
            router: { back: vi.fn(), push: vi.fn(), replace: vi.fn() },
            params: { id: 'machine-1' },
        }).module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: modalSpies }).module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: { getState: () => ({ applyFriends: vi.fn() }) },
            useSessions: () => [],
            useAllMachines: () => [],
            useMachine: () => null,
            useSettings: () => {
                React.useMemo(() => 0, []);
                return {
                    experiments: true,
                    codexBackendMode: 'acp',
                };
            },
            useSetting: (name: string) => {
                React.useMemo(() => 0, [name]);
                if (name === 'experiments') return true;
                return false;
            },
            useSettingMutable: (name: string) => {
                React.useMemo(() => 0, [name]);
                return [null, vi.fn()];
            },
            useLocalSetting: (name: string) => {
                React.useMemo(() => 0, [name]);
                if (name === 'uiFontScale') return 1;
                return null;
            },
        });
    },
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: React.PropsWithChildren<Record<string, never>>) => React.createElement(React.Fragment, null, children),
}));
vi.mock('@/components/ui/lists/ItemGroupTitleWithAction', () => ({
    ItemGroupTitleWithAction: () => null,
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: React.PropsWithChildren<Record<string, never>>) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: () => null,
}));
vi.mock('@/components/ui/pathBrowser/PathInputBrowseButton', () => ({
    PathInputBrowseButton: () => null,
}));
vi.mock('@/components/ui/pathBrowser/openMachinePathBrowserModal', () => ({
    openMachinePathBrowserModal: vi.fn(async () => null),
}));

vi.mock('@/components/machines/DetectedClisList', () => ({
    DetectedClisList: () => null,
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: () => null,
}));
vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/hooks/session/useNavigateToSession', () => {
    return { useNavigateToSession: () => () => {} };
});
vi.mock('@/hooks/ui/useMountedShouldContinue', () => ({
    useMountedShouldContinue: () => () => true,
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => {
    type UseMachineCapabilitiesParams = {
        request: Record<string, unknown>;
    };
    return {
        useMachineCapabilitiesCache: (params: UseMachineCapabilitiesParams) => {
            requests.push(params.request);
            return { state: { status: 'idle' }, refresh: vi.fn() };
        },
    };
});

vi.mock('@/sync/ops', () => {
    return {
        machineCapabilitiesInvoke: vi.fn(),
        machineSpawnNewSession: vi.fn(),
        machineStopDaemon: vi.fn(),
        machineStopSession: vi.fn(),
        machineUpdateMetadata: vi.fn(),
        machineExecutionRunsList: vi.fn(async () => ({ ok: true, runs: [] })),
        machineRevokeFromAccount: vi.fn(async () => ({ ok: true })),
    };
});
vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStop: vi.fn(async () => ({ ok: true })),
}));

vi.mock('@/sync/sync', () => {
    return { sync: { refreshMachines: vi.fn(), retryNow: vi.fn() } };
});
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

vi.mock('@/utils/sessions/machineUtils', () => {
    return { isMachineOnline: () => true };
});

vi.mock('@/utils/sessions/sessionUtils', () => {
    return {
        formatPathRelativeToHome: () => '',
        getSessionName: () => '',
        getSessionSubtitle: () => '',
    };
});

vi.mock('@/utils/path/pathUtils', () => {
    return { resolveAbsolutePath: () => '' };
});

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerId: () => 'server-a',
}));

vi.mock('@/sync/domains/settings/terminalSettings', () => {
    return { resolveTerminalSpawnOptions: () => ({}) };
});
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode', () => ({
    readMachineWindowsRemoteSessionLaunchMode: () => undefined,
    resolveEffectiveWindowsRemoteSessionLaunchMode: () => ({ mode: 'visible' }),
}));
vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex'],
    DEFAULT_AGENT_ID: 'codex',
    getAgentCore: () => ({ cli: { detectKey: 'codex' } }),
    isAgentId: () => true,
}));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: () => null,
}));
vi.mock('@/components/machines/InstallableDepInstaller', () => ({
    InstallableDepInstaller: () => null,
}));
vi.mock('@/components/sessions/runs/ExecutionRunRow', () => ({
    ExecutionRunRow: () => null,
}));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchModeOptions', () => ({
    WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS: [],
}));
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: vi.fn(async () => true),
}));
vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: () => null,
}));

describe('MachineDetailScreen capabilities request', () => {
    it('passes a stable request object to useMachineCapabilitiesCache', async () => {
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(React.createElement(MachineDetailScreen))).tree;

        act(() => {
            tree!.update(React.createElement(MachineDetailScreen));
        });

        expect(requests.length).toBeGreaterThanOrEqual(2);
        expect(requests[0]).toBe(requests[1]);
    });
});
