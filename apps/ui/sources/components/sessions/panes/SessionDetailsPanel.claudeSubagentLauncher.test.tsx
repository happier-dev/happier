import * as React from 'react';
import renderer from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
                select: (_: unknown) => 1,
            },
            ActivityIndicator: 'ActivityIndicator',
            View: 'View',
            Pressable: 'Pressable',
            ScrollView: 'ScrollView',
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
    icons: () => ({
        Octicons: 'Octicons',
        Ionicons: 'Ionicons',
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useLocalSetting: (key: string) => {
                return null;
            },
            useLocalSettingMutable: () => [false, vi.fn()],
        });
    },
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        unpinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        openDetailsTab: vi.fn(),
        setDetailsTabState: vi.fn(),
        scopeState: {
            details: {
                isOpen: true,
                activeTabKey: 'claude-subagent-launcher:member:qa-team',
                tabState: {},
                tabs: [
                    {
                        key: 'claude-subagent-launcher:member:qa-team',
                        kind: 'claudeSubagentLauncher',
                        title: 'Launch Claude teammate',
                        isPinned: false,
                        isPreview: true,
                        resource: { kind: 'claudeSubagentLauncher', mode: 'member', initialTeamId: 'qa-team' },
                    },
                ],
            },
        },
    }),
}));

const launcherViewSpy = vi.fn();
let SessionDetailsPanel: typeof import('./SessionDetailsPanel').SessionDetailsPanel;

vi.mock('@/agents/providers/claude/sessionSubagents/SessionClaudeSubagentLauncherView', () => ({
    SessionClaudeSubagentLauncherView: (props: any) => {
        launcherViewSpy(props);
        return React.createElement('SessionClaudeSubagentLauncherView');
    },
}));

vi.mock('@/components/sessions/runs/launcher/SessionExecutionRunLauncherView', () => ({
    SessionExecutionRunLauncherView: () => React.createElement('SessionExecutionRunLauncherView'),
}));

vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: () => React.createElement('SessionEmbeddedTerminalPane'),
}));

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => React.createElement('SessionCommitDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: () => React.createElement('SessionFileDetailsView'),
}));

describe('SessionDetailsPanel (Claude subagent launcher resource)', () => {
    beforeAll(async () => {
        ({ SessionDetailsPanel } = await import('./SessionDetailsPanel'));
    }, 60_000);

    it('renders SessionClaudeSubagentLauncherView for Claude launcher tabs', async () => {
        launcherViewSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />)).tree;

        expect(tree).toBeTruthy();
        expect(launcherViewSpy).toHaveBeenCalledTimes(1);
        expect(launcherViewSpy.mock.calls[0]?.[0]).toMatchObject({
            sessionId: 's1',
            mode: 'member',
            initialTeamId: 'qa-team',
            presentation: 'panel',
        });
    });

    it('renders Claude launcher tabs without an intermediate loading fallback', async () => {
        launcherViewSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />)).tree;

        expect(tree).toBeTruthy();
        expect(tree!.findAllByType('ActivityIndicator')).toHaveLength(0);
        expect(launcherViewSpy).toHaveBeenCalledTimes(1);
    });
});
