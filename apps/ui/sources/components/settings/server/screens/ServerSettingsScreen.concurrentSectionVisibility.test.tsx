import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let controllerValue: any = null;

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            KeyboardAvoidingView: ({ children }: any) => React.createElement('KeyboardAvoidingView', null, children),
            Platform: {
                OS: 'ios',
                select: ({ ios, default: defaultValue }: any) => ios ?? defaultValue,
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock().module;
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {},
        });
    },
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children, ...props }: any) => React.createElement('ItemList', props, children),
}));

vi.mock('@/components/ui/keyboardAvoidance', () => ({
    KeyboardAwareScrollView: ({ children, ...props }: any) =>
        React.createElement('KeyboardAwareScrollView', props, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: any) => React.createElement('ItemGroup', { title }, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/settings/server/sections/SavedServersSection', () => ({
    SavedServersSection: (props: any) => React.createElement('SavedServersSection', props),
}));

vi.mock('@/components/settings/server/sections/ServerRetentionSection', () => ({
    ServerRetentionSection: (props: any) => React.createElement('ServerRetentionSection', props),
}));

vi.mock('@/components/settings/server/sections/AddTargetsSection', () => ({
    AddTargetsSection: (props: any) => React.createElement('AddTargetsSection', props),
}));

vi.mock('@/components/settings/server/sections/ServerGroupsSection', () => ({
    ServerGroupsSection: (props: any) => React.createElement('ServerGroupsSection', props),
}));

vi.mock('@/components/settings/server/RelayDriftActionCard', () => ({
    RelayDriftActionCard: (props: any) => React.createElement('RelayDriftActionCard', props),
}));

vi.mock('@/components/settings/server/localControl/LocalRelayRuntimeControlSection', () => ({
    LocalRelayRuntimeControlSection: (props: any) => React.createElement('LocalRelayRuntimeControlSection', props),
}));
vi.mock('@/components/settings/server/localControl/LocalRelayAccessControlSection', () => ({
    LocalRelayAccessControlSection: (props: any) => React.createElement('LocalRelayAccessControlSection', props),
}));

vi.mock('@/components/settings/server/hooks/useServerSettingsScreenController', () => ({
    useServerSettingsScreenController: () => controllerValue,
}));

function setController(overrides: Partial<any>) {
    controllerValue = {
        screenOptions: { headerShown: true, headerTitle: 'Relay settings', headerBackTitle: 'Back' },
        servers: [],
        serverGroups: [],
        activeServerId: 'server-a',
        activeServerUrl: '',
        activeLocalRelayUrl: null,
        deviceDefaultServerId: 'server-a',
        activeTargetKey: null,
        authStatusByServerId: {},
        relayDriftBanner: null,

        autoMode: false,
        inputUrl: '',
        inputName: '',
        error: null,
        isValidating: false,
        onChangeUrl: vi.fn(),
        onChangeName: vi.fn(),
        onResetServer: vi.fn(),
        onAddServer: vi.fn(),

        onSwitchServer: vi.fn(),
        onSwitchGroup: vi.fn(),
        onRenameServer: vi.fn(),
        onRemoveServer: vi.fn(),
        onRenameGroup: vi.fn(),
        onRemoveGroup: vi.fn(),
        onCreateServerGroup: vi.fn(async () => false),

        groupSelectionEnabled: false,
        setGroupSelectionEnabled: vi.fn(),
        groupSelectionPresentation: 'grouped',
        activeServerGroupId: null,
        selectedGroupServerIds: new Set<string>(),
        onToggleGroupPresentation: vi.fn(),
        onToggleGroupServer: vi.fn(),

        ...overrides,
    };
}

describe('ServerSettingsScreen (concurrent section visibility)', () => {
    it('hides concurrent multi-relay settings when there are no relay groups', async () => {
        setController({ serverGroups: [] });

        const { ServerSettingsScreen } = await import('./ServerSettingsScreen');

        const screen = await renderScreen(React.createElement(ServerSettingsScreen));

        expect(screen.findAllByType('KeyboardAwareScrollView' as any)).toHaveLength(1);
        expect(screen.findAllByType('KeyboardAvoidingView' as any)).toHaveLength(0);
        expect(screen.findAllByType('ServerGroupsSection' as any)).toHaveLength(0);
    });

    it('shows concurrent multi-relay settings when there is at least one relay group', async () => {
        setController({
            serverGroups: [{ id: 'grp-one', name: 'Group One', serverIds: ['server-a'], presentation: 'grouped' }],
        });

        const { ServerSettingsScreen } = await import('./ServerSettingsScreen');

        const screen = await renderScreen(React.createElement(ServerSettingsScreen));

        expect(screen.findAllByType('ServerGroupsSection' as any)).toHaveLength(1);
    });

    it('shows the relay drift banner when the controller reports drift', async () => {
        setController({
            relayDriftBanner: {
                kind: 'warning',
                title: 'relay.banner.title',
                description: 'relay.banner.description',
                actionLabel: 'relay.banner.action',
            },
        });

        const { ServerSettingsScreen } = await import('./ServerSettingsScreen');

        const screen = await renderScreen(React.createElement(ServerSettingsScreen));

        const banners = screen.findAllByType('RelayDriftActionCard' as any);
        expect(banners).toHaveLength(0);

        const notice = screen.findByTestId('settings.server.relayDrift.readOnlyNotice');
        expect(notice?.props.subtitle).toBe('relay.banner.description');
    });

    it('shows the local relay control surfaces on the Relay settings screen', async () => {
        setController({ relayDriftBanner: null });

        const { ServerSettingsScreen } = await import('./ServerSettingsScreen');

        const screen = await renderScreen(React.createElement(ServerSettingsScreen));

        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as any)).toHaveLength(0);
        expect(screen.findAllByType('LocalRelayAccessControlSection' as any)).toHaveLength(0);
        expect(screen.findByTestId('settings.server.localControl.desktopOnlyNotice')).toBeTruthy();
    });

    it('does not render the standalone Tailscale secure-access section on the Relay settings screen', async () => {
        const previousTauriInternals = (globalThis as any).__TAURI_INTERNALS__;
        (globalThis as any).__TAURI_INTERNALS__ = { invoke: () => undefined };
        setController({
            relayDriftBanner: null,
            activeServerUrl: 'https://relay.example.test',
            activeLocalRelayUrl: 'http://127.0.0.1:4555',
        });

        try {
            const { ServerSettingsScreen } = await import('./ServerSettingsScreen');

            const screen = await renderScreen(React.createElement(ServerSettingsScreen));

            expect(screen.findAllByType('LocalRelayRuntimeControlSection' as any)).toHaveLength(1);
            expect(screen.findAllByType('LocalRelayAccessControlSection' as any)).toHaveLength(1);
        } finally {
            if (previousTauriInternals === undefined) delete (globalThis as any).__TAURI_INTERNALS__;
            else (globalThis as any).__TAURI_INTERNALS__ = previousTauriInternals;
        }
    });

    it('keeps secure-access local control desktop-only even when a known local relay alias exists', async () => {
        setController({
            activeServerUrl: 'https://relay.example.test',
            activeLocalRelayUrl: 'http://127.0.0.1:4555',
            relayDriftBanner: null,
        });

        const { ServerSettingsScreen } = await import('./ServerSettingsScreen');

        const screen = await renderScreen(React.createElement(ServerSettingsScreen));

        expect(screen.findByTestId('settings.server.localControl.desktopOnlyNotice')).toBeTruthy();
    });

    it('hides local relay control surfaces when setup surface policy denies local relay host (desktop)', async () => {
        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'setup.relay.allowLocalRelayHost';
        (globalThis as any).__TAURI_INTERNALS__ = { invoke: () => undefined };
        try {
            setController({ relayDriftBanner: null });

            const { ServerSettingsScreen } = await import('./ServerSettingsScreen');
            const screen = await renderScreen(React.createElement(ServerSettingsScreen));

            expect(screen.findAllByType('LocalRelayRuntimeControlSection' as any)).toHaveLength(0);
            expect(screen.findAllByType('LocalRelayAccessControlSection' as any)).toHaveLength(0);
        } finally {
            delete (globalThis as any).__TAURI_INTERNALS__;
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('hides the local Tailscale surface when setup surface policy denies it (desktop)', async () => {
        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'setup.relayAccess.allowTailscale';
        (globalThis as any).__TAURI_INTERNALS__ = { invoke: () => undefined };
        try {
            setController({ relayDriftBanner: null });

            const { ServerSettingsScreen } = await import('./ServerSettingsScreen');
            const screen = await renderScreen(React.createElement(ServerSettingsScreen));

            expect(screen.findAllByType('LocalRelayRuntimeControlSection' as any)).toHaveLength(1);
            expect(screen.findAllByType('LocalRelayAccessControlSection' as any)).toHaveLength(1);
        } finally {
            delete (globalThis as any).__TAURI_INTERNALS__;
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('hides relay selection/setup surfaces when setup surface policy denies relay selection', async () => {
        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'setup.relay.allowRelaySelection';
        try {
            setController({ relayDriftBanner: null });

            const { ServerSettingsScreen } = await import('./ServerSettingsScreen');
            const screen = await renderScreen(React.createElement(ServerSettingsScreen));

            expect(screen.findByTestId('settings.server.openSetupWizard')).toBeNull();
            expect(screen.findAllByType('AddTargetsSection' as any)).toHaveLength(0);
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('keeps relay form actions tappable while the keyboard is open', async () => {
        setController({ relayDriftBanner: null });

        const { ServerSettingsScreen } = await import('./ServerSettingsScreen');

        const screen = await renderScreen(React.createElement(ServerSettingsScreen));
        const itemList = screen.findByType('KeyboardAwareScrollView' as any);

        expect(itemList.props.keyboardShouldPersistTaps).toBe('handled');
        expect(itemList.props.keyboardDismissMode).toBe('interactive');
        expect(itemList.props.automaticallyAdjustKeyboardInsets).toBe(true);
    });
});
