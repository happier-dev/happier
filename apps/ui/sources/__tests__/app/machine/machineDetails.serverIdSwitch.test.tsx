import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class {} };

const switchSpy = vi.fn(async () => true);
const refreshMachinesThrottledSpy = vi.fn(async () => {});

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
        useLocalSearchParams: () => ({ id: 'machine-1', serverId: 'server-b' }),
        useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
    };
});

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: { header: { tint: '#000' }, input: { background: '#fff', text: '#000' }, groupped: { background: '#fff', sectionTitle: '#000' }, divider: '#ddd', button: { primary: { background: '#000', tint: '#fff' } }, text: '#000', textSecondary: '#666', surface: '#fff', surfaceHigh: '#fff', shadow: { color: '#000', opacity: 0.1 }, status: { error: '#f00', connected: '#0f0', connecting: '#ff0', disconnected: '#999', default: '#999' }, permissionButton: { inactive: { background: '#ccc' } } } } }),
    StyleSheet: { create: (fn: any) => fn({ colors: { header: { tint: '#000' }, input: { background: '#fff', text: '#000' }, groupped: { background: '#fff', sectionTitle: '#000' }, divider: '#ddd', button: { primary: { background: '#000', tint: '#fff' } }, text: '#000', textSecondary: '#666', surface: '#fff', surfaceHigh: '#fff', shadow: { color: '#000', opacity: 0.1 }, status: { error: '#f00', connected: '#0f0', connecting: '#ff0', disconnected: '#999', default: '#999' }, permissionButton: { inactive: { background: '#ccc' } } } }) },
}));

vi.mock('@/constants/Typography', () => ({ Typography: { default: () => ({}) } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

vi.mock('@/components/ui/lists/Item', () => ({ Item: () => null }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: ({ children }: any) => React.createElement(React.Fragment, null, children) }));
vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children) }));
vi.mock('@/components/ui/forms/MultiTextInput', () => ({ MultiTextInput: () => null }));
vi.mock('@/components/machines/DetectedClisList', () => ({ DetectedClisList: () => null }));
vi.mock('@/components/ui/forms/Switch', () => ({ Switch: () => null }));
vi.mock('@/components/machines/InstallableDepInstaller', () => ({ InstallableDepInstaller: () => null }));

vi.mock('@/modal', () => ({ Modal: { alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn(), show: vi.fn() } }));

vi.mock('@/sync/domains/state/storage', () => {
    const React = require('react');
    return {
        useSessions: () => [],
        useMachine: () => null,
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

vi.mock('@/utils/sessions/machineUtils', () => ({ isMachineOnline: () => true }));
vi.mock('@/utils/sessions/sessionUtils', () => ({ formatPathRelativeToHome: () => '', getSessionName: () => '', getSessionSubtitle: () => '' }));
vi.mock('@/utils/path/pathUtils', () => ({ resolveAbsolutePath: () => '' }));
vi.mock('@/sync/domains/settings/terminalSettings', () => ({ resolveTerminalSpawnOptions: () => ({}) }));
vi.mock('@/sync/domains/session/spawn/windowsRemoteSessionConsole', () => ({ resolveWindowsRemoteSessionConsoleFromMachineMetadata: () => 'visible' }));
vi.mock('@/capabilities/installableDepsRegistry', () => ({ getInstallableDepRegistryEntries: () => [] }));

describe('MachineDetailScreen (serverId param switching)', () => {
    it('switches active server when serverId param is provided and differs from current active server', async () => {
        switchSpy.mockClear();
        refreshMachinesThrottledSpy.mockClear();

        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        await act(async () => {
            renderer.create(React.createElement(MachineDetailScreen));
            await Promise.resolve();
        });

        expect(switchSpy).toHaveBeenCalledWith({ serverId: 'server-b', scope: 'device' });
        expect(refreshMachinesThrottledSpy).toHaveBeenCalled();
    });
});
