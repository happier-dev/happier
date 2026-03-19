import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settingsState: Record<string, any> = {
    sessionReplayEnabled: true,
    sessionReplayStrategy: 'summary_plus_recent',
    sessionReplayRecentMessagesCount: 100,
    sessionReplayMaxSeedChars: 50_000,
    sessionReplaySummaryRunnerV1: null,
    sessionUseTmux: false,
    sessionTmuxSessionName: null,
    sessionTmuxIsolated: false,
    sessionTmuxTmpDir: null,
    sessionMessageSendMode: 'agent_queue',
    sessionBusySteerSendPolicy: 'server_pending',
    agentInputEnterToSend: true,
    agentInputHistoryScope: 'perSession',
    terminalConnectLegacySecretExportEnabled: false,
    sessionTagsEnabled: true,
    sessionsRightPaneDefaultOpen: false,
    uiMultiPanePanelsEnabled: false,
};

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    TextInput: 'TextInput',
    ScrollView: 'ScrollView',
    Pressable: 'Pressable',
    ActivityIndicator: 'ActivityIndicator',
    useWindowDimensions: () => ({ width: 1440, height: 900, scale: 1, fontScale: 1 }),
    Dimensions: {
        get: () => ({ width: 1440, height: 900 }),
    },
    Platform: {
        OS: 'web',
        select: (values: any) => values?.default ?? values?.web ?? values?.ios ?? values?.android,
    },
    AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), prompt: vi.fn(async () => null) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            dark: true,
            colors: {
                text: '#fff',
                textSecondary: '#999',
                textDestructive: '#f44',
                success: '#0f0',
                surface: '#111',
                surfacePressedOverlay: 'rgba(255,255,255,0.08)',
                surfaceSelected: 'rgba(255,255,255,0.12)',
                surfaceRipple: 'rgba(255,255,255,0.12)',
                surfaceHigh: '#222',
                surfaceHighest: '#333',
                divider: '#444',
                shadow: { color: '#000', opacity: 0.1 },
                accent: { blue: '#00f', orange: '#f60', indigo: '#66f' },
                input: { placeholder: '#666' },
                groupped: {
                    background: '#111',
                    chevron: '#888',
                    sectionTitle: '#888',
                },
            },
        },
    }),
    StyleSheet: {
        create: (input: any) =>
            typeof input === 'function'
                ? input({
                    dark: true,
                    colors: {
                        text: '#fff',
                        textSecondary: '#999',
                        textDestructive: '#f44',
                        success: '#0f0',
                        surface: '#111',
                        surfacePressedOverlay: 'rgba(255,255,255,0.08)',
                        surfaceSelected: 'rgba(255,255,255,0.12)',
                        surfaceRipple: 'rgba(255,255,255,0.12)',
                        surfaceHigh: '#222',
                        surfaceHighest: '#333',
                        divider: '#444',
                        shadow: { color: '#000', opacity: 0.1 },
                        accent: { blue: '#00f', orange: '#f60', indigo: '#66f' },
                        input: { placeholder: '#666' },
                        groupped: { background: '#111', chevron: '#888', sectionTitle: '#888' },
                    },
                }, {})
                : input,
    },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1024, headerMaxWidth: 1024 },
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: ({ children }: any) => (typeof children === 'function' ? children({ maxHeight: 320, maxWidth: 320 }) : children),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: 'Switch',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
    TextInput: 'TextInput',
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude'],
}));

vi.mock('@/agents/catalog/catalog', () => ({
    DEFAULT_AGENT_ID: 'claude',
    isAgentId: (value: unknown) => value === 'claude',
    getAgentCore: () => ({ displayNameKey: 'agents.claude.displayName' }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useAllMachines: () => [],
    useLocalSetting: () => 1,
}));

vi.mock('@/components/settings/pickers/resolvePreferredMachineId', () => ({
    resolvePreferredMachineId: () => null,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: (key: string) => [
        key in settingsState ? settingsState[key] : null,
        (next: any) => {
            settingsState[key] = next;
        },
    ],
    useLocalSettingMutable: (key: string) => [
        key in settingsState ? settingsState[key] : null,
        (next: any) => {
            settingsState[key] = next;
        },
    ],
    useSetting: (key: string) => {
        if (key === 'recentMachinePaths') return [];
        return null;
    },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'execution.runs',
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
}));

vi.mock('@/components/sessions/new/hooks/screenModel/useNewSessionPreflightModelsState', () => ({
    useNewSessionPreflightModelsState: () => ({
        modelOptions: [],
        probe: { phase: 'idle', refresh: vi.fn() },
    }),
}));

vi.mock('@/utils/system/fireAndForget', () => ({
    fireAndForget: (promise: unknown) => promise,
}));

describe('Session settings (summary runner text-node guard)', () => {
    it('does not emit raw text nodes under non-Text parents when summary runner controls are visible', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(SessionSettingsScreen));
        });

        const json = tree.toJSON();
        const badNodes: Array<{ parent: string | null; value: string }> = [];

        const walk = (node: any, parentType: string | null) => {
            if (node == null) return;
            if (typeof node === 'string') {
                if (parentType !== 'Text' && node.trim().length > 0) {
                    badNodes.push({ parent: parentType, value: node });
                }
                return;
            }
            const nextParent = typeof node.type === 'string' ? node.type : null;
            const children = Array.isArray(node.children) ? node.children : [];
            for (const child of children) walk(child, nextParent);
        };

        walk(json, null);

        expect(badNodes).toEqual([]);
    });
});
