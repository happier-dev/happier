import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

type ReactActEnvironmentGlobal = typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
    expo?: unknown;
};
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).expo = { EventEmitter: class {} };

const requests: Array<Record<string, unknown>> = [];
const machineThemeColors = {
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
};

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

vi.mock('@expo/vector-icons', () => {
    return {
        Ionicons: 'Ionicons',
        Octicons: 'Octicons',
    };
});

vi.mock('expo-router', () => {
    const Stack: { Screen: () => null } = { Screen: () => null };
    return {
        Stack,
        useLocalSearchParams: () => ({ id: 'machine-1' }),
        useRouter: () => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() }),
    };
});

vi.mock('react-native-unistyles', () => {
    const React = require('react');
    return {
        useUnistyles: () => {
            React.useMemo(() => 0, []);
            return {
                theme: { colors: machineThemeColors },
            };
        },
        StyleSheet: {
            create: (fn: (theme: { colors: typeof machineThemeColors }) => unknown) => fn({ colors: machineThemeColors }),
        },
    };
});

vi.mock('@/constants/Typography', () => {
    return { Typography: { default: () => ({}) } };
});

vi.mock('@/text', () => {
    return { t: (key: string) => key };
});

vi.mock('@/components/ui/lists/Item', () => ({
    Item: () => null,
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: React.PropsWithChildren<Record<string, never>>) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: React.PropsWithChildren<Record<string, never>>) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: () => null,
}));

vi.mock('@/components/machines/DetectedClisList', () => ({
    DetectedClisList: () => null,
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: () => null,
}));

vi.mock('@/modal', () => {
    return { Modal: { alert: vi.fn(), confirm: vi.fn(), prompt: vi.fn(), show: vi.fn() } };
});

vi.mock('@/sync/domains/state/storage', () => {
    const React = require('react');
    return {
        storage: { getState: () => ({ applyFriends: vi.fn() }) },
        useSessions: () => [],
        useAllMachines: () => [],
        useMachine: () => null,
        useSettings: () => {
            React.useMemo(() => 0, []);
            return {
                experiments: true,
                codexBackendMode: 'mcp_resume',
            };
        },
        useSetting: (name: string) => {
            React.useMemo(() => 0, [name]);
            if (name === 'experiments') return true;
            return false;
        },
        useSettingMutable: (name: string) => {
            React.useMemo(() => 0, [name]);
            return [name === 'codexMcpResumeInstallSpec' ? '' : null, vi.fn()];
        },
    };
});

vi.mock('@/hooks/session/useNavigateToSession', () => {
    return { useNavigateToSession: () => () => {} };
});

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
        machineUpdateMetadata: vi.fn(),
    };
});

vi.mock('@/sync/sync', () => {
    return { sync: { refreshMachines: vi.fn(), retryNow: vi.fn() } };
});

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

vi.mock('@/sync/domains/settings/terminalSettings', () => {
    return { resolveTerminalSpawnOptions: () => ({}) };
});

describe('MachineDetailScreen capabilities request', () => {
    it('passes a stable request object to useMachineCapabilitiesCache', async () => {
        const { default: MachineDetailScreen } = await import('@/app/(app)/machine/[id]');

        let tree: renderer.ReactTestRenderer | undefined;
        act(() => {
            tree = renderer.create(React.createElement(MachineDetailScreen));
        });

        act(() => {
            tree!.update(React.createElement(MachineDetailScreen));
        });

        expect(requests.length).toBeGreaterThanOrEqual(2);
        expect(requests[0]).toBe(requests[1]);
    });
});
