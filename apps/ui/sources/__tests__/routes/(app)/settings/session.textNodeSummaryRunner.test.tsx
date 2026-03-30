import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    collectUnexpectedRawTextNodes,
} from '@/dev/testkit/render/renderScreen';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit';
import { createStorageModuleMock } from '@/dev/testkit/mocks/storage';
import {
    installSessionSettingsEntryModuleMocks,
    resetSessionSettingsEntryState,
    sessionSettingsEntryState,
} from './sessionSettingsEntryTestHelpers';

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

installSessionSettingsEntryModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
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
        });
    },
    featureEnabled: (featureId) => featureId === 'execution.runs',
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => {}),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 1024, headerMaxWidth: 1024 },
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: ({ children }: any) => (typeof children === 'function' ? children({ maxHeight: 320, maxWidth: 320 }) : children),
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/agents/hooks/useEnabledAgentIds', () => ({
    useEnabledAgentIds: () => ['claude'],
}));

vi.mock('@/agents/catalog/catalog', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/agents/catalog/catalog')>()),
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

vi.mock('@/sync/domains/state/storage', async (importOriginal) => await createStorageModuleMock({
    importOriginal,
    overrides: {
        useSettingMutable: (key: string) => [
            key in sessionSettingsEntryState.settingsState ? sessionSettingsEntryState.settingsState[key] : null,
            (next: any) => {
                sessionSettingsEntryState.settingsState[key] = next;
            },
        ] as any,
        useLocalSettingMutable: (key: string) => [
            key in sessionSettingsEntryState.settingsState ? sessionSettingsEntryState.settingsState[key] : null,
            (next: any) => {
                sessionSettingsEntryState.settingsState[key] = next;
            },
        ] as any,
        useSetting: (key: string) => {
            if (key === 'recentMachinePaths') return [];
            return null;
        },
    },
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

sessionSettingsEntryState.settingsState = settingsState;

afterEach(() => {
    standardCleanup();
    resetSessionSettingsEntryState();
});

describe('Session settings (summary runner text-node guard)', () => {
    it('does not emit raw text nodes under non-Text parents when summary runner controls are visible', async () => {
        const mod = await import('@/app/(app)/settings/session');
        const SessionSettingsScreen = mod.default;

        const screen = await renderScreen(React.createElement(SessionSettingsScreen));
        const badNodes = collectUnexpectedRawTextNodes(screen.tree.toJSON());
        expect(badNodes).toEqual([]);
    });
});
