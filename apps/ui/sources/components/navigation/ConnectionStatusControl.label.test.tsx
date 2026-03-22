import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';


(
    globalThis as typeof globalThis & {
        IS_REACT_ACT_ENVIRONMENT?: boolean;
    }
).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: {
                        OS: 'web',
                        select: (options: { web?: unknown; default?: unknown; ios?: unknown; android?: unknown }) =>
                            options.web ?? options.default ?? options.ios ?? options.android,
                    },
                    View: 'View',
                    Pressable: 'Pressable',
                }
    );
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                status: {
                    connected: '#00ff00',
                    connecting: '#ffcc00',
                    actionRequired: '#ff9900',
                    disconnected: '#999999',
                    error: '#ff0000',
                    default: '#999999',
                },
                text: '#111111',
                textSecondary: '#666666',
            },
        },
    });
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

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

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
    useSocketStatus: () => ({ status: 'connected' }),
    useSyncError: () => null,
    useLastSyncAt: () => null,
    useSettingMutable: () => [null, vi.fn()],
});
});

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

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { replace: vi.fn(), push: vi.fn() },
    });
    return routerMock.module;
});

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

vi.mock('@/components/navigation/connectionStatus/useConnectionHealth', () => ({
    useConnectionHealth: () => ({
        kind: 'no_machine',
        color: '#ff9900',
        isPulsing: false,
        statusLabelKey: 'status.actionRequired',
        machineLabelKey: 'newSession.noMachinesFound',
    }),
}));

describe('ConnectionStatusControl (label)', () => {
    it('shows the active server name instead of a generic connection status label', async () => {
        const { ConnectionStatusControl } = await import('./ConnectionStatusControl');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'header' }))).tree;

        const texts = tree.findAllByType('Text' as any);
        const joined = texts.map((node: any) => String(node.props.children ?? '')).join(' ');
        expect(joined).toContain('Happier Cloud');
        expect(joined).not.toContain('status.connected');
    });

    it('uses a single-line tail ellipsis contract for long sidebar server labels', async () => {
        const { ConnectionStatusControl } = await import('./ConnectionStatusControl');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'sidebar' }))).tree;

        const trigger = tree.findByType('Pressable' as any);
        expect(trigger.props.style).toMatchObject({
            flexShrink: 1,
            maxWidth: '100%',
            minWidth: 0,
        });
        expect(trigger.props.style.width).toBeUndefined();

        const label = tree.findAllByType('Text' as any).find((node: any) => String(node.props.children ?? '') === 'Happier Cloud');
        expect(label).toBeTruthy();
        expect(label!.props.numberOfLines).toBe(1);
        expect(label!.props.ellipsizeMode).toBe('tail');
        expect(label!.props.style).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    flexGrow: 0,
                    flexShrink: 1,
                    minWidth: 0,
                }),
            ]),
        );
    });

    it('uses the action-required status color when the server is connected but no machines are available', async () => {
        const { ConnectionStatusControl } = await import('./ConnectionStatusControl');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(React.createElement(ConnectionStatusControl, { variant: 'header' }))).tree;

        const dot = tree.findByType('StatusDot' as any);
        expect(dot.props.color).toBe('#ff9900');
    });
});
