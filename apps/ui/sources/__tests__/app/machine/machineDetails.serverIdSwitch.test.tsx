import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMachineDetailsCommonModuleMocks } from './machineDetailsTestHelpers';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class {} };

const { refreshMachinesThrottledSpy, switchSpy } = vi.hoisted(() => ({
    refreshMachinesThrottledSpy: vi.fn(async () => {}),
    switchSpy: vi.fn(async () => true),
}));

installMachineDetailsCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { back: vi.fn(), push: vi.fn(), replace: vi.fn() },
            params: { id: 'machine-1', serverId: 'server-b' },
        });
        return routerMock.module;
    },
});

vi.mock('@/components/ui/lists/Item', () => ({ Item: () => null }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children) }));
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

vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => () => {} }));
vi.mock('@/hooks/ui/useMountedShouldContinue', () => ({
    useMountedShouldContinue: () => () => true,
}));
vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({ useMachineCapabilitiesCache: () => ({ state: { status: 'idle' }, refresh: vi.fn() }) }));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerId: () => 'server-a',
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: switchSpy,
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: refreshMachinesThrottledSpy,
        refreshMachines: vi.fn(),
        retryNow: vi.fn(),
    },
}));
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

describe('MachineDetailScreen (serverId param switching)', () => {
    it('switches active server when serverId param is provided and differs from current active server', async () => {
        switchSpy.mockClear();
        refreshMachinesThrottledSpy.mockClear();

        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const unhandledSpy = vi.fn();
        process.on('unhandledRejection', unhandledSpy);

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        refreshMachinesThrottledSpy.mockRejectedValueOnce(new Error('network down'));

        try {
            await renderScreen(React.createElement(MachineDetailScreen));

            await flushHookEffects({ cycles: 2, turns: 1 });
        } finally {
            process.removeListener('unhandledRejection', unhandledSpy);
            consoleError.mockRestore();
        }

        expect(switchSpy).toHaveBeenCalledWith({ serverId: 'server-b', scope: 'device' });
        expect(refreshMachinesThrottledSpy).toHaveBeenCalled();
        expect(unhandledSpy).not.toHaveBeenCalled();
    });
});
