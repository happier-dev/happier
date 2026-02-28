import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                status: {
                    connected: '#00ff00',
                    connecting: '#ffcc00',
                    disconnected: '#999999',
                    error: '#ff0000',
                    default: '#999999',
                },
                text: '#111111',
                textSecondary: '#666666',
            },
        },
    }),
    StyleSheet: { create: (fn: any) => fn({ colors: { status: {}, text: '', textSecondary: '' } }) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: 'StatusDot',
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: () => null,
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSocketStatus: () => ({ status: 'connected' }),
    useSyncError: () => null,
    useLastSyncAt: () => null,
    useSettingMutable: () => [null, vi.fn()],
}));

vi.mock('@/sync/domains/server/serverConfig', () => ({
    getServerUrl: () => 'https://cloud.example.test',
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerId: () => 'srv-1',
    listServerProfiles: () => [{ id: 'srv-1', name: 'Happier Cloud', serverUrl: 'https://cloud.example.test' }],
    setActiveServerId: vi.fn(),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ isAuthenticated: true, refreshFromActiveServer: vi.fn(async () => {}) }),
}));

vi.mock('@/auth/storage/tokenStorage', () => ({
    TokenStorage: { getCredentialsForServerUrl: vi.fn(async () => ({ token: 't', secret: 's' })) },
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

vi.mock('@/sync/runtime/orchestration/connectionManager', () => ({
    switchConnectionToActiveServer: vi.fn(async () => {}),
}));

vi.mock('@/sync/domains/server/selection/serverSelectionResolver', () => ({
    listServerSelectionTargets: () => [],
}));

vi.mock('@/sync/domains/server/selection/serverSelectionResolution', () => ({
    resolveActiveServerSelectionFromRawSettings: () => ({ activeTarget: { kind: 'server', id: 'srv-1' } }),
}));

vi.mock('@/sync/domains/server/url/serverUrlDisplay', () => ({
    toServerUrlDisplay: (value: string) => value,
}));

vi.mock('@/components/navigation/connection/useConnectionTargetActions', () => ({
    useConnectionTargetActions: () => ({}),
}));

vi.mock('@/components/navigation/connection/ConnectionTargetList', () => ({
    ConnectionTargetList: () => null,
}));

vi.mock('@/components/settings/server/modals/ServerSwitchAuthPrompt', () => ({
    promptSignedOutServerSwitchConfirmation: vi.fn(async () => true),
}));

describe('ConnectionStatusControl (label)', () => {
    it('shows the active server name instead of a generic connection status label', async () => {
        const { ConnectionStatusControl } = await import('./ConnectionStatusControl');

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(ConnectionStatusControl, { variant: 'header' }));
        });

        const texts = tree.root.findAllByType('Text' as any);
        const joined = texts.map((node: any) => String(node.props.children ?? '')).join(' ');
        expect(joined).toContain('Happier Cloud');
        expect(joined).not.toContain('status.connected');
    });
});
