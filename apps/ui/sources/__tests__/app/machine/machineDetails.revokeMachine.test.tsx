import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class { } };

const itemSpy = vi.fn();
const routerMock = { back: vi.fn(), push: vi.fn(), replace: vi.fn() };
const confirmSpy = vi.fn<(..._args: any[]) => Promise<boolean>>(async () => true);
const refreshMachinesThrottledSpy = vi.fn(async () => {});
const revokeSpy = vi.fn(async (_machineId: string) => ({ ok: true as const }));

vi.mock('react-native-reanimated', () => ({}));

vi.mock('react-native', () => {
    type PlatformSelectOptions<T> = { web?: T; default?: T };
    return {
        Platform: { OS: 'web', select: <T,>(options: PlatformSelectOptions<T>) => options.web ?? options.default },
        TurboModuleRegistry: { getEnforcing: () => ({}) },
        View: 'View',
        Text: 'Text',
        ScrollView: 'ScrollView',
        ActivityIndicator: 'ActivityIndicator',
        RefreshControl: 'RefreshControl',
        Pressable: 'Pressable',
        TextInput: 'TextInput',
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('expo-router', () => {
    const Stack: { Screen: () => null } = { Screen: () => null };
    return {
        Stack,
        useLocalSearchParams: () => ({ id: 'machine-1' }),
        useRouter: () => routerMock,
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                header: { tint: '#000' },
                input: { background: '#fff', text: '#000' },
                groupped: { background: '#fff', sectionTitle: '#000' },
                divider: '#ddd',
                button: { primary: { background: '#000', tint: '#fff' } },
                text: '#000',
                textSecondary: '#666',
                surface: '#fff',
                surfaceHigh: '#fff',
                shadow: { color: '#000', opacity: 0.1 },
                status: { error: '#f00', connected: '#0f0', connecting: '#ff0', disconnected: '#999', default: '#999' },
                permissionButton: { inactive: { background: '#ccc' } },
            }
        }
    }),
    StyleSheet: { create: (fn: any) => fn({ colors: { header: { tint: '#000' }, input: { background: '#fff', text: '#000' }, groupped: { background: '#fff', sectionTitle: '#000' }, divider: '#ddd', button: { primary: { background: '#000', tint: '#fff' } }, text: '#000', textSecondary: '#666', surface: '#fff', surfaceHigh: '#fff', shadow: { color: '#000', opacity: 0.1 }, status: { error: '#f00', connected: '#0f0', connecting: '#ff0', disconnected: '#999', default: '#999' }, permissionButton: { inactive: { background: '#ccc' } } } }) },
}));

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => {
        itemSpy(props);
        return React.createElement(React.Fragment, null, null);
    }
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children) }));
vi.mock('@/components/ui/lists/ItemGroupTitleWithAction', () => ({ ItemGroupTitleWithAction: () => null }));
vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children) }));
vi.mock('@/components/ui/forms/MultiTextInput', () => ({ MultiTextInput: () => null }));
vi.mock('@/components/machines/DetectedClisList', () => ({ DetectedClisList: () => null }));
vi.mock('@/components/ui/forms/Switch', () => ({ Switch: () => null }));
vi.mock('@/components/machines/InstallableDepInstaller', () => ({ InstallableDepInstaller: () => null }));
vi.mock('@/components/sessions/runs/ExecutionRunRow', () => ({ ExecutionRunRow: () => null }));

vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: confirmSpy, prompt: vi.fn(), show: vi.fn() } }));

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

vi.mock('@/sync/domains/state/storage', () => {
    const React = require('react');
    return {
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
        useSetting: (name: string) => {
            React.useMemo(() => 0, [name]);
            return false;
        },
        useSettingMutable: (name: string) => {
            React.useMemo(() => 0, [name]);
            return [null, vi.fn()];
        },
        useSettings: () => {
            React.useMemo(() => 0, []);
            return {};
        },
    };
});

vi.mock('@/hooks/session/useNavigateToSession', () => ({ useNavigateToSession: () => () => {} }));
vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({ useMachineCapabilitiesCache: () => ({ state: { status: 'idle' }, refresh: vi.fn() }) }));
vi.mock('@/sync/domains/server/serverProfiles', () => ({ getActiveServerId: () => 'server-a' }));
vi.mock('@/sync/domains/server/activeServerSwitch', () => ({ setActiveServerAndSwitch: vi.fn(async () => true) }));
vi.mock('@/sync/sync', () => ({ sync: { refreshMachinesThrottled: refreshMachinesThrottledSpy, refreshMachines: vi.fn(), retryNow: vi.fn() } }));
vi.mock('@/utils/sessions/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/utils/sessions/sessionUtils', () => ({ formatPathRelativeToHome: () => '', getSessionName: () => '', getSessionSubtitle: () => '' }));
vi.mock('@/utils/path/pathUtils', () => ({ resolveAbsolutePath: () => '' }));
vi.mock('@/sync/domains/settings/terminalSettings', () => ({ resolveTerminalSpawnOptions: () => ({}) }));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionConsole', () => ({ resolveWindowsRemoteSessionConsoleFromMachineMetadata: () => 'visible' }));
vi.mock('@/capabilities/installablesRegistry', () => ({ getInstallablesRegistryEntries: () => [] }));

describe('MachineDetailScreen (revoke/forget machine)', () => {
    beforeEach(() => {
        itemSpy.mockReset();
        confirmSpy.mockReset();
        refreshMachinesThrottledSpy.mockReset();
        revokeSpy.mockReset();
        routerMock.back.mockReset();
    });

    it('confirms and revokes the machine', async () => {
        confirmSpy.mockResolvedValueOnce(true);

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        await act(async () => {
            renderer.create(React.createElement(MachineDetailScreen));
            await Promise.resolve();
        });

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
        expect(routerMock.back).toHaveBeenCalled();
    });
});
