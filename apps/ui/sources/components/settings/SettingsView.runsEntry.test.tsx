import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let mockFeatureEnabled: (featureId: string) => boolean = (featureId: string) => featureId === 'execution.runs';

const routerPushSpy = vi.fn();

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    Platform: {
        OS: 'web',
        select: (options: any) => (options && 'default' in options ? options.default : undefined),
    },
    Linking: { canOpenURL: async () => false, openURL: async () => {} },
    Text: 'Text',
    ActivityIndicator: 'ActivityIndicator',
}));

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'StyledText',
    TextInput: 'TextInput',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: (cb: () => void) => cb(),
}));

vi.mock('expo-constants', () => ({
    default: { expoConfig: { version: '0.0.0-test' } },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
        mono: () => ({}),
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
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

vi.mock('@/sync/domains/state/storage', () => ({
    useEntitlement: () => false,
    useLocalSettingMutable: () => [false, vi.fn()],
    useSetting: (key: string) => {
        if (key === 'serverSelectionGroups') return [];
        if (key === 'serverSelectionActiveTargetKind') return null;
        if (key === 'serverSelectionActiveTargetId') return null;
        if (key === 'experiments') return false;
        if (key === 'featureToggles') return {};
        if (key === 'useProfiles') return false;
        if (key === 'sessionUseTmux') return false;
        return null;
    },
    useAllMachines: () => [],
    useMachineListByServerId: () => ({}),
    useMachineListStatusByServerId: () => ({}),
    useProfile: () => ({ id: 'prof_1', firstName: '', connectedServices: [] }),
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

vi.mock('@/modal', () => ({
    Modal: {
        alert: vi.fn(),
        confirm: vi.fn(async () => false),
        prompt: vi.fn(async () => null),
    },
}));

vi.mock('@/hooks/ui/useMultiClick', () => ({
    useMultiClick: (cb: () => void) => cb,
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1000 },
}));

vi.mock('@/hooks/ui/useHappyAction', () => ({
    useHappyAction: (fn: any) => [false, fn],
}));

vi.mock('@/sync/api/account/apiVendorTokens', () => ({
    disconnectVendorToken: vi.fn(async () => {}),
}));

vi.mock('@/sync/domains/profiles/profile', () => ({
    getDisplayName: () => 'Test User',
    getAvatarUrl: () => null,
    getBio: () => '',
}));

vi.mock('@/components/ui/avatar/Avatar', () => ({
    Avatar: 'Avatar',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/components/sessions/new/components/MachineCliGlyphs', () => ({
    MachineCliGlyphs: 'MachineCliGlyphs',
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'claude', 'gemini'],
    DEFAULT_AGENT_ID: 'agent_default',
    getAgentCore: () => ({ connectedService: { name: 'Anthropic', connectRoute: null } }),
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => null,
    resolveAgentIdFromConnectedServiceId: () => null,
}));

vi.mock('@/components/settings/supportUsBehavior', () => ({
    resolveSupportUsAction: () => 'github',
}));

vi.mock('@/utils/system/bugReportActionTrail', () => ({
    recordBugReportUserAction: vi.fn(),
}));

vi.mock('@/hooks/server/useAutomationsSupport', () => ({
    useAutomationsSupport: () => ({ enabled: false }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => mockFeatureEnabled(featureId),
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-1', serverUrl: 'https://local.example.test', generation: 0 }),
    listServerProfiles: () => [],
}));

afterEach(() => {
    routerPushSpy.mockClear();
});

describe('SettingsView (runs entry)', () => {
    it('includes a Runs entry that routes to /runs when execution runs are enabled', async () => {
        const { SettingsView } = await import('./SettingsView');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SettingsView));
        });

        const items = tree.root.findAllByType('Item' as any);
        const runsItem = items.find((item: any) => item?.props?.title === 'runs.title');
        expect(runsItem).toBeTruthy();

        await act(async () => {
            runsItem!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/runs');
    });

    it('does not include a Sub-agent entry (it is located under Session settings)', async () => {
        const { SettingsView } = await import('./SettingsView');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SettingsView));
        });

        const items = tree.root.findAllByType('Item' as any);
        const subAgentItem = items.find((item: any) => item?.props?.title === 'Sub-agent');
        expect(subAgentItem).toBeFalsy();
    });

    it('does not include an Actions entry (it is located under Session settings)', async () => {
        const { SettingsView } = await import('./SettingsView');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SettingsView));
        });

        const items = tree.root.findAllByType('Item' as any);
        const actionsItem = items.find((item: any) => item?.props?.title === 'Actions');
        expect(actionsItem).toBeFalsy();
    });

    it("omits the What's New entry when changelog UI is disabled by build policy", async () => {
        const previousDeny = process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
        process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = 'app.ui.changelog';
        vi.resetModules();

        try {
            const { SettingsView } = await import('./SettingsView');

            let tree!: ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(React.createElement(SettingsView));
            });

            const items = tree.root.findAllByType('Item' as any);
            const whatsNewItem = items.find((item: any) => item?.props?.title === 'settings.whatsNew');
            expect(whatsNewItem).toBeFalsy();
        } finally {
            if (previousDeny === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY;
            else process.env.EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY = previousDeny;
        }
    });

    it('hides feature-gated entries when disabled by feature policy', async () => {
        mockFeatureEnabled = (featureId) => featureId === 'execution.runs';
        const { SettingsView } = await import('./SettingsView');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SettingsView));
        });

        const items = tree.root.findAllByType('Item' as any);
        const voiceItem = items.find((item: any) => item?.props?.title === 'settings.voiceAssistant');
        const sourceControlItem = items.find((item: any) => item?.props?.title === 'Source control');
        const memorySearchItem = items.find((item: any) => item?.props?.title === 'settings.memorySearch');

        expect(voiceItem).toBeFalsy();
        expect(sourceControlItem).toBeFalsy();
        expect(memorySearchItem).toBeFalsy();
    });

    it('shows feature-gated entries when voice, source control, and memory search are enabled', async () => {
        mockFeatureEnabled = (featureId) =>
            ['execution.runs', 'voice', 'scm.writeOperations', 'memory.search'].includes(featureId);
        const { SettingsView } = await import('./SettingsView');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SettingsView));
        });

        const items = tree.root.findAllByType('Item' as any);
        const voiceItem = items.find((item: any) => item?.props?.title === 'settings.voiceAssistant');
        const sourceControlItem = items.find((item: any) => item?.props?.title === 'Source control');
        const memorySearchItem = items.find((item: any) => item?.props?.title === 'settings.memorySearch');

        expect(voiceItem).toBeTruthy();
        expect(sourceControlItem).toBeTruthy();
        expect(memorySearchItem).toBeTruthy();
    });
});
