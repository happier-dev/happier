import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

let controllerValue: any = null;
let routerMock: ReturnType<typeof createExpoRouterMock> | null = null;

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            KeyboardAvoidingView: ({ children }: any) => React.createElement('KeyboardAvoidingView', null, children),
            Platform: {
                OS: 'web',
                select: ({ web, default: defaultValue }: any) => web ?? defaultValue,
            },
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        routerMock = createExpoRouterMock();
        return routerMock.module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({ theme: {} });
    },
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
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

describe('ServerSettingsScreen web gating', () => {
    it('keeps the web relay settings screen free of desktop-only local control surfaces', async () => {
        setController({ relayDriftBanner: null });
        const { ServerSettingsScreen } = await import('./ServerSettingsScreen');
        const screen = await renderScreen(React.createElement(ServerSettingsScreen));

        expect(screen.findAllByType('LocalRelayRuntimeControlSection' as any)).toHaveLength(0);
        expect(screen.findAllByType('LocalRelayAccessControlSection' as any)).toHaveLength(0);
        const notice = screen.findByTestId('settings.server.openSetupWizard');
        expect(notice).toBeTruthy();
        expect(notice?.props.title).toBe('setupOnboarding.setupNewRelayAction');
        expect(notice?.props.subtitle).toBe('setupOnboarding.openSetupWizardSubtitle');
        expect(typeof notice?.props.onPress).toBe('function');

        await notice?.props.onPress?.();
        expect(routerMock?.spies.push).toHaveBeenCalledWith('/setup/wizard?scope=relay&step=setup_chooser');
    });
});
