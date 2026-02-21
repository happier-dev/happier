import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();
const linkingCanOpenURLSpy = vi.fn(async () => false);
const linkingOpenURLSpy = vi.fn(async () => {});

vi.mock('react-native', () => ({
    View: 'View',
    Pressable: 'Pressable',
    Platform: {
        OS: 'web',
        select: (options: any) => (options && 'default' in options ? options.default : undefined),
    },
    Linking: { canOpenURL: linkingCanOpenURLSpy, openURL: linkingOpenURLSpy },
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

vi.mock('@/utils/sessions/machineUtils', () => ({
    isMachineOnline: () => false,
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
    useFeatureEnabled: () => false,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-1', serverUrl: 'https://local.example.test', generation: 0 }),
    listServerProfiles: () => [],
}));

afterEach(() => {
    routerPushSpy.mockClear();
    linkingCanOpenURLSpy.mockClear();
    linkingOpenURLSpy.mockClear();
});

describe('SettingsView', () => {
    it('includes a first-class Servers entry that routes to /server', async () => {
        const { SettingsView } = await import('./SettingsView');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SettingsView));
        });

        const items = tree.root.findAllByType('Item' as any);
        const serversItem = items.find((item: any) => item?.props?.title === 'settings.servers');
        expect(serversItem).toBeTruthy();

        await act(async () => {
            serversItem!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/server');
    });

    it('routes to the in-app bug report composer by default when Report issue is pressed', async () => {
        const { SettingsView } = await import('./SettingsView');

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SettingsView));
        });

        const items = tree.root.findAllByType('Item' as any);
        const reportIssueItem = items.find((item: any) => item?.props?.title === 'settings.reportIssue');
        expect(reportIssueItem).toBeTruthy();

        await act(async () => {
            await reportIssueItem!.props.onPress();
        });

        expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/report-issue');
        expect(linkingOpenURLSpy).not.toHaveBeenCalled();
    });

    it('opens EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL when set and supported instead of routing to the composer', async () => {
        const previousUrl = process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL;
        process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL = 'https://example.test/report-issue';
        linkingCanOpenURLSpy.mockResolvedValue(true);

        try {
            const { SettingsView } = await import('./SettingsView');

            let tree!: ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(React.createElement(SettingsView));
            });

            const items = tree.root.findAllByType('Item' as any);
            const reportIssueItem = items.find((item: any) => item?.props?.title === 'settings.reportIssue');
            expect(reportIssueItem).toBeTruthy();

            await act(async () => {
                await reportIssueItem!.props.onPress();
            });

            expect(linkingCanOpenURLSpy).toHaveBeenCalledWith('https://example.test/report-issue');
            expect(linkingOpenURLSpy).toHaveBeenCalledWith('https://example.test/report-issue');
            expect(routerPushSpy).not.toHaveBeenCalledWith('/(app)/settings/report-issue');
        } finally {
            if (previousUrl === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL;
            else process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL = previousUrl;
        }
    });

    it('falls back to routing when EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL is set but cannot be opened', async () => {
        const previousUrl = process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL;
        process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL = 'https://example.test/report-issue';
        linkingCanOpenURLSpy.mockResolvedValue(false);

        try {
            const { SettingsView } = await import('./SettingsView');

            let tree!: ReactTestRenderer;
            await act(async () => {
                tree = renderer.create(React.createElement(SettingsView));
            });

            const items = tree.root.findAllByType('Item' as any);
            const reportIssueItem = items.find((item: any) => item?.props?.title === 'settings.reportIssue');
            expect(reportIssueItem).toBeTruthy();

            await act(async () => {
                await reportIssueItem!.props.onPress();
            });

            expect(linkingCanOpenURLSpy).toHaveBeenCalledWith('https://example.test/report-issue');
            expect(linkingOpenURLSpy).not.toHaveBeenCalled();
            expect(routerPushSpy).toHaveBeenCalledWith('/(app)/settings/report-issue');
        } finally {
            if (previousUrl === undefined) delete process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL;
            else process.env.EXPO_PUBLIC_HAPPIER_REPORT_ISSUE_URL = previousUrl;
        }
    });
});
