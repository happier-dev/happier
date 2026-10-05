import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSettingsViewCommonModuleMocks } from './settingsViewTestHelpers';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockFeatureEnabled: (featureId: string) => boolean = (featureId: string) => featureId === 'execution.runs';
const automationsSupportState = {
    enabled: false,
    discoverable: false,
    blockedBy: 'server' as string | null,
};

const routerPushSpy = vi.fn();

installSettingsViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock(
            {
                View: 'View',
                Pressable: 'Pressable',
                Dimensions: {
                    get: () => ({ width: 1600, height: 900, scale: 2, fontScale: 1 }),
                },
                useWindowDimensions: () => ({ width: 1600, height: 900, scale: 2, fontScale: 1 }),
                Platform: {
                    OS: 'web',
                    select: (options: any) => (options && 'default' in options ? options.default : undefined),
                },
                Linking: {
                    canOpenURL: async () => false,
                    openURL: async () => {},
                },
                Text: 'Text',
                ActivityIndicator: 'ActivityIndicator',
            },
        );
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock({
            router: { push: routerPushSpy },
        });
        return routerMock.module;
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: vi.fn(),
                confirm: vi.fn(async () => false),
                prompt: vi.fn(async () => null),
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async (importOriginal) => await importOriginal<typeof import('@/sync/domains/state/storage')>(),
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'StyledText',
    TextInput: 'TextInput',
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { push: routerPushSpy },
    });
    return routerMock.module;
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' } },
}));


vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: (props: any) => React.createElement('ItemGroup', props, props.children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), connectWithUrl: vi.fn(), isLoading: false }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: null }),
}));

vi.mock('@/sync/sync', () => ({
    sync: {
        refreshMachinesThrottled: vi.fn(async () => {}),
        presentPaywall: vi.fn(async () => ({ success: false, error: 'nope' })),
        refreshProfile: vi.fn(async () => {}),
    },
}));

vi.mock('@/track', () => ({
    trackPaywallButtonClicked: vi.fn(),
    trackWhatsNewClicked: vi.fn(),
}));

vi.mock('@/hooks/ui/useMultiClick', () => ({
    useMultiClick: (cb: () => void) => cb,
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
    useLayoutMaxWidth: () => 1000,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 1000 }),
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));

vi.mock('@/sync/domains/profiles/profile', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/profiles/profile')>(),
    getDisplayName: () => 'Test User',
    getAvatarUrl: () => null,
    getBio: () => '',
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: 'MachineCliGlyphs',
}));

vi.mock('@/components/settings/supportUsBehavior', () => ({
    resolveSupportUsAction: () => 'github',
}));

vi.mock('@/utils/system/bugReportActionTrail', () => ({
    recordBugReportUserAction: vi.fn(),
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({
        enabled: automationsSupportState.enabled,
        discoverable: automationsSupportState.discoverable,
        blockedBy: automationsSupportState.blockedBy,
    }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => mockFeatureEnabled(featureId),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => null,
}));

vi.mock('@/sync/domains/server/serverProfiles', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/server/serverProfiles')>(),
    getActiveServerSnapshot: () => ({ serverId: 'server-1', serverUrl: 'https://local.example.test', generation: 0 }),
    listServerProfiles: () => [],
    subscribeActiveServer: (listener: any) => {
        listener({ serverId: 'server-1', serverUrl: 'https://local.example.test', generation: 0 });
        return () => {};
    },
}));

beforeEach(async () => {
    const { storage } = await import('@/sync/domains/state/storage');
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    storage.setState({ settings: settingsDefaults, machines: {}, machineListByServerId: {} });
});

afterEach(() => {
    routerPushSpy.mockClear();
    automationsSupportState.enabled = false;
    automationsSupportState.discoverable = false;
    automationsSupportState.blockedBy = 'server';
});

// Resolve the real screen graph during collection, not inside an interaction's
// timeout. The build-policy owner rekeys its cache when public env changes.
await import('./SettingsView');

describe('SettingsView (runs entry)', () => {
    async function renderSettingsViewUnderTest() {
        const { SettingsView } = await import('./SettingsView');
        return renderSettingsView(React.createElement(SettingsView));
    }

    it('includes a Runs entry that routes to /runs when execution runs are enabled', async () => {
        const screen = await renderSettingsViewUnderTest();
        // Category sections arrive in deferred stages after the first paint.
        await vi.waitFor(() => expect(screen.findRowByTitle('runs.title')).toBeTruthy());

        await screen.pressRowByTitle('runs.title');

        // Web defers catalog navigation past the press (deferOnWeb).

        await vi.waitFor(() => expect(routerPushSpy).toHaveBeenCalledWith('/runs'));
    });

    it('includes a Transcript entry that routes to /settings/session/transcript', async () => {
        const screen = await renderSettingsViewUnderTest();
        // Category sections arrive in deferred stages after the first paint.
        await vi.waitFor(() => expect(screen.findRowByTitle('settings.transcript')).toBeTruthy());

        await screen.pressRowByTitle('settings.transcript');

        // Web defers catalog navigation past the press (deferOnWeb).

        await vi.waitFor(() => expect(routerPushSpy).toHaveBeenCalledWith('/settings/session/transcript'));
    });

    it('keeps the run settings entry discoverable when only local feature flags are off and routes to Features', async () => {
        automationsSupportState.enabled = false;
        automationsSupportState.discoverable = true;
        automationsSupportState.blockedBy = 'local_policy';

        const screen = await renderSettingsViewUnderTest();
        await vi.waitFor(() => expect(screen.findRowByTitle('workflows.destination.runSettingsPage.title')).toBeTruthy());
        const runSettingsItem = screen.findRowByTitle('workflows.destination.runSettingsPage.title');
        expect(runSettingsItem?.props?.subtitle).toBe('settingsFeatures.expAutomationsSubtitle');

        await screen.pressRowByTitle('workflows.destination.runSettingsPage.title');

        // Web defers catalog navigation past the press (deferOnWeb).

        await vi.waitFor(() => expect(routerPushSpy).toHaveBeenCalledWith('/settings/features'));
    });

    it('opens Workflows run settings from Settings (FIN 04 §3.5)', async () => {
        automationsSupportState.enabled = true;
        automationsSupportState.discoverable = true;
        automationsSupportState.blockedBy = null;

        const screen = await renderSettingsViewUnderTest();
        await vi.waitFor(() => expect(screen.findRowByTitle('workflows.destination.runSettingsPage.title')).toBeTruthy());

        await screen.pressRowByTitle('workflows.destination.runSettingsPage.title');

        await vi.waitFor(() => expect(routerPushSpy).toHaveBeenCalledWith('/workflows/settings'));
    });

    it('includes a Permissions entry that routes to /settings/session/permissions', async () => {
        const screen = await renderSettingsViewUnderTest();
        // Category sections arrive in deferred stages after the first paint.
        await vi.waitFor(() => expect(screen.findRowByTitle('settings.permissions')).toBeTruthy());

        await screen.pressRowByTitle('settings.permissions');

        // Web defers catalog navigation past the press (deferOnWeb).

        await vi.waitFor(() => expect(routerPushSpy).toHaveBeenCalledWith('/settings/session/permissions'));
    });

    it('includes a Subagents entry that routes to /settings/sub-agent', async () => {
        const screen = await renderSettingsViewUnderTest();
        // Category sections arrive in deferred stages after the first paint.
        await vi.waitFor(() => expect(screen.findRowByTitle('subAgentGuidance.settings.groupTitle')).toBeTruthy());

        await screen.pressRowByTitle('subAgentGuidance.settings.groupTitle');

        // Web defers catalog navigation past the press (deferOnWeb).

        await vi.waitFor(() => expect(routerPushSpy).toHaveBeenCalledWith('/settings/sub-agent'));
    });

    it('includes an Actions entry that routes to /settings/actions', async () => {
        const screen = await renderSettingsViewUnderTest();
        // Category sections arrive in deferred stages after the first paint.
        await vi.waitFor(() => expect(screen.findRowByTitle('common.actions')).toBeTruthy());

        await screen.pressRowByTitle('common.actions');

        // Web defers catalog navigation past the press (deferOnWeb).

        await vi.waitFor(() => expect(routerPushSpy).toHaveBeenCalledWith('/settings/actions'));
    });

    it("omits the What's New entry when changelog UI is disabled by build policy", async () => {
        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'app.ui.changelog';

        try {
            const screen = await renderSettingsViewUnderTest();
            expect(screen.findRowByTitle('settings.whatsNew')).toBeNull();
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('hides feature-gated entries when disabled by feature policy', async () => {
        mockFeatureEnabled = (featureId) => featureId === 'execution.runs';
        const screen = await renderSettingsViewUnderTest();

        // The Voice root also owns ungated local dictation/privacy settings;
        // only Conversations is gated by the server's Voice capability.
        expect(screen.findRowByTitle('settings.voiceAssistant')).not.toBeNull();
        expect(screen.findRowByTitle('settings.filesSourceControl')).toBeNull();
        expect(screen.findRowByTitle('settings.memorySearch')).toBeNull();
    });

    it('hides the files and source control group when all child entries are disabled', async () => {
        mockFeatureEnabled = (featureId) => featureId === 'execution.runs';
        const screen = await renderSettingsViewUnderTest();

        expect(screen.findAllByProps({ title: 'settings.filesAndSourceControl' })).toEqual([]);
    });

    it('shows feature-gated entries when voice, source control, and memory search are enabled', async () => {
        mockFeatureEnabled = (featureId) =>
            ['execution.runs', 'voice', 'scm.writeOperations', 'memory.search'].includes(featureId);
        const screen = await renderSettingsViewUnderTest();

        // Category sections arrive in deferred stages after the first paint.

        await vi.waitFor(() => expect(screen.findRowByTitle('settings.voiceAssistant')).toBeTruthy());
        // Category sections arrive in deferred stages after the first paint.
        await vi.waitFor(() => expect(screen.findRowByTitle('settings.filesSourceControl')).toBeTruthy());
        // Category sections arrive in deferred stages after the first paint.
        await vi.waitFor(() => expect(screen.findRowByTitle('settings.memorySearch')).toBeTruthy());
    });
});
