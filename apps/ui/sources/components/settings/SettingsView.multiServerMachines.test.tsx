import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const routerPushSpy = vi.fn();

vi.mock('react-native', async (importOriginal) => {
    const actual: any = await importOriginal();
    return {
        ...actual,
        View: 'View',
        Pressable: 'Pressable',
        Text: 'Text',
        ActivityIndicator: 'ActivityIndicator',
        Platform: {
            ...actual.Platform,
            OS: 'web',
            select: (options: any) => (options && 'default' in options ? options.default : undefined),
        },
        Linking: { canOpenURL: async () => false, openURL: async () => {} },
    };
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: 'StyledText',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: routerPushSpy }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@react-navigation/native', () => ({
    useFocusEffect: () => {},
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
    ItemList: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children, title }: any) =>
        React.createElement(React.Fragment, null, title ? React.createElement('Title', null, title) : null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ title, subtitle }: any) =>
        React.createElement('Text', null, `${title}${subtitle ? ` ${subtitle}` : ''}`),
}));

vi.mock('@/hooks/session/useConnectTerminal', () => ({
    useConnectTerminal: () => ({ connectTerminal: vi.fn(), connectWithUrl: vi.fn(), isLoading: false }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: null }),
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

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: false,
            colors: {
                surface: '#ffffff',
                text: '#111111',
                textSecondary: '#666666',
                status: { connected: '#00ff00', disconnected: '#ff0000' },
                groupped: { background: '#fff', sectionTitle: '#666' },
            },
        },
    }),
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

afterEach(() => {
    routerPushSpy.mockClear();
});

describe('SettingsView (multi-server machines)', () => {
    it('renders machines from all servers in the active group target', async () => {
        const previousScope = process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
        const scope = `test_${Date.now()}_${Math.random().toString(16).slice(2)}`;
        process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;

        try {
            vi.resetModules();

            const profiles = await import('@/sync/domains/server/serverProfiles');
            const a = profiles.upsertServerProfile({ serverUrl: 'http://localhost:3013', name: 'Server A' });
            const b = profiles.upsertServerProfile({ serverUrl: 'http://localhost:3012', name: 'Server B' });
            profiles.setActiveServerId(a.id, { scope: 'device' });

            const { getStorage } = await import('@/sync/domains/state/storage');
            const store = getStorage();
            store.getState().applySettingsLocal({
                serverSelectionGroups: [{ id: 'grp', name: 'Group', serverIds: [a.id, b.id], presentation: 'grouped' }],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'grp',
            } as any);

            // Populate per-server machine caches.
            profiles.setActiveServerId(a.id, { scope: 'device' });
            store.getState().applyMachines([{
                id: 'mach-a1',
                active: true,
                createdAt: 1,
                updatedAt: 1,
                metadata: { host: 'a.local', displayName: 'Machine A1' },
            } as any], true);
            profiles.setActiveServerId(b.id, { scope: 'device' });
            store.getState().applyMachines([{
                id: 'mach-b1',
                active: true,
                createdAt: 2,
                updatedAt: 2,
                metadata: { host: 'b.local', displayName: 'Machine B1' },
            } as any], true);
            profiles.setActiveServerId(a.id, { scope: 'device' });

            const { SettingsView } = await import('./SettingsView');

            let tree: renderer.ReactTestRenderer | null = null;
            await act(async () => {
                tree = renderer.create(React.createElement(SettingsView));
            });

            expect(JSON.stringify(tree!.toJSON())).toContain('Machine A1');
            expect(JSON.stringify(tree!.toJSON())).toContain('Machine B1');
            const groupTitles = tree!.root
                .findAll((node) => String(node.type) === 'Title')
                .map((node) => String((Array.isArray(node.props.children) ? node.props.children.join('') : node.props.children) ?? ''));
            expect(groupTitles).toContain('Server A');
            expect(groupTitles).toContain('Server B');
        } finally {
            if (previousScope === undefined) {
                delete process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE;
            } else {
                process.env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = previousScope;
            }
        }
    });
});
