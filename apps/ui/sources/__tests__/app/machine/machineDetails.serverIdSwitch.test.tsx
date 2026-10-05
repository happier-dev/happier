import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installMachineDetailsCommonModuleMocks } from './machineDetailsTestHelpers';
import { createStorageModuleStub, createStorageStoreMock } from '@/dev/testkit/mocks/storage';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { settingsParse } from '@/sync/domains/settings/settings';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
};

(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class {} };

const { refreshMachinesThrottledSpy, switchSpy } = vi.hoisted(() => ({
    refreshMachinesThrottledSpy: vi.fn(async () => {}),
    switchSpy: vi.fn(async () => true),
}));
const machineCollectBugReportDiagnosticsMock = vi.hoisted(() => vi.fn(async () => null));

installMachineDetailsCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { back: vi.fn(), push: vi.fn(), replace: vi.fn() },
            params: { id: 'machine-1', serverId: 'server-b' },
        });
        return routerMock.module;
    },
    storage: async () => createStorageModuleStub({
        storage: createStorageStoreMock({ profile: profileDefaults, settings: settingsParse({}) }),
        useSessions: () => [],
        useAllMachines: () => [
            {
                id: 'machine-1',
                active: true,
                activeAt: Date.now(),
                createdAt: Date.now(),
                updatedAt: Date.now(),
                seq: 1,
                metadata: {
                    displayName: 'Machine One',
                    host: 'machine-one.local',
                    platform: 'darwin',
                    happyCliVersion: '1.2.3',
                    happyHomeDir: '/Users/tester/.happier',
                    homeDir: '/Users/tester',
                },
                metadataVersion: 1,
                daemonState: null,
                daemonStateVersion: 0,
                revokedAt: null,
            },
        ],
        useMachine: () => ({
            id: 'machine-1',
            active: true,
            activeAt: Date.now(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            seq: 1,
            metadata: {
                displayName: 'Machine One',
                host: 'machine-one.local',
                platform: 'darwin',
                happyCliVersion: '1.2.3',
                happyHomeDir: '/Users/tester/.happier',
                homeDir: '/Users/tester',
            },
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 0,
            revokedAt: null,
        }),
        useSetting: () => false,
        useSettingMutable: () => [null, vi.fn()],
        useSettings: () => settingsParse({}),
    }),
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

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    areServerProfileIdentifiersEquivalent: (left: unknown, right: unknown) => String(left ?? '').trim() === String(right ?? '').trim(),
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
vi.mock('@/utils/sessions/sessionUtils', () => ({ formatOSPlatform: (platform?: string) => platform ?? '', formatPathRelativeToHome: () => '', getSessionName: () => '', getSessionSubtitle: () => '' }));
vi.mock('@/utils/path/pathUtils', () => ({ resolveAbsolutePath: () => '' }));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionConsole', () => ({ resolveWindowsRemoteSessionConsoleFromMachineMetadata: () => 'visible' }));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchMode', () => ({
    readMachineWindowsRemoteSessionLaunchMode: () => undefined,
    resolveEffectiveWindowsRemoteSessionLaunchMode: () => ({ mode: 'visible' }),
}));
vi.mock('@/capabilities/installablesRegistry', () => ({ getInstallablesRegistryEntries: () => [] }));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: () => null,
}));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionLaunchModeOptions', () => ({
    WINDOWS_REMOTE_SESSION_LAUNCH_MODE_OPTIONS: [],
}));
vi.mock('@/sync/ops/sessionMachineTarget', () => ({
    readMachineTargetForSession: () => null,
}));
vi.mock('@/sync/ops/machines', () => ({
    machineCollectBugReportDiagnostics: machineCollectBugReportDiagnosticsMock,
}));

// Load after the boundary harness is configured, outside the individual behavior test's timeout.
const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');
const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');

describe('MachineDetailScreen (serverId param switching)', () => {
    it('uses the hosted Machine destination scope instead of the unrelated Expo route', async () => {
        switchSpy.mockClear();
        await renderScreen(<AppPaneProvider><DestinationInstanceHost tabId="machine-tab"
            ref={{ kind: 'settings', params: { pageId: 'machines/machine-1', id: 'machine-1', serverId: 'server-c' } }}
            pathname="/settings/machines/machine-1" focused visible
            navigation={{ push: () => {}, replace: () => {}, back: () => {} }}>
            <MachineDetailScreen />
        </DestinationInstanceHost></AppPaneProvider>);
        await flushHookEffects({ cycles: 2, turns: 1 });
        expect(switchSpy).toHaveBeenCalledWith({ serverId: 'server-c', scope: 'tab' });
        expect(switchSpy).not.toHaveBeenCalledWith({ serverId: 'server-b', scope: 'tab' });
    });
    it('switches active server when serverId param is provided and differs from current active server', async () => {
        switchSpy.mockClear();
        refreshMachinesThrottledSpy.mockClear();
        machineCollectBugReportDiagnosticsMock.mockClear();

        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const unhandledSpy = vi.fn();
        process.on('unhandledRejection', unhandledSpy);


        refreshMachinesThrottledSpy.mockRejectedValueOnce(new Error('network down'));

        try {
            await renderScreen(<AppPaneProvider><MachineDetailScreen /></AppPaneProvider>);

            await flushHookEffects({ cycles: 2, turns: 1 });
        } finally {
            process.removeListener('unhandledRejection', unhandledSpy);
            consoleError.mockRestore();
        }

        expect(switchSpy).toHaveBeenCalledWith({ serverId: 'server-b', scope: 'tab' });
        expect(refreshMachinesThrottledSpy).toHaveBeenCalled();
        expect(machineCollectBugReportDiagnosticsMock).not.toHaveBeenCalled();
        expect(unhandledSpy).not.toHaveBeenCalled();
    });
});
