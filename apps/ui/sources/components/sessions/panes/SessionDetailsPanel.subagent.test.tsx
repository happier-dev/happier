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
                select: (_: any) => 1,
            },
            AppState: {
                currentState: 'active',
                addEventListener: vi.fn(() => ({ remove: vi.fn() })),
            },
            ActivityIndicator: 'ActivityIndicator',
            View: 'View',
            Pressable: 'Pressable',
            ScrollView: 'ScrollView',
        });
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
        setActiveDetailsTab: vi.fn(),
        scopeState: {
            details: {
                isOpen: true,
                activeTabKey: 'subagent:execution_run:run_1',
                tabs: [
                    {
                        key: 'subagent:execution_run:run_1',
                        kind: 'subagent',
                        title: 'Code review',
                        subtitle: 'Subagent · Codex',
                        isPinned: false,
                        isPreview: true,
                        resource: { kind: 'subagent', subagentId: 'execution_run:run_1' },
                    },
                ],
            },
        },
    }),
}));

const subagentViewSpy = vi.fn();
let SessionDetailsPanel: typeof import('./SessionDetailsPanel').SessionDetailsPanel;

vi.mock('@/components/sessions/agents/details/SessionSubagentDetailsView', () => ({
    SessionSubagentDetailsView: (props: any) => {
        subagentViewSpy(props);
        return React.createElement('SessionSubagentDetailsView');
    },
}));

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => React.createElement('SessionCommitDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: () => React.createElement('SessionFileDetailsView'),
}));

vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: () => React.createElement('SessionEmbeddedTerminalPane'),
}));

describe('SessionDetailsPanel (subagent resource)', () => {
    beforeAll(async () => {
        ({ SessionDetailsPanel } = await import('./SessionDetailsPanel'));
    }, 60_000);

    it('renders SessionSubagentDetailsView for subagent tabs', async () => {
        subagentViewSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        tree = (await renderScreen(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />)).tree;

        expect(tree).toBeTruthy();
        expect(subagentViewSpy).toHaveBeenCalledTimes(1);
        expect(subagentViewSpy.mock.calls[0]?.[0]).toMatchObject({
            sessionId: 's1',
            scopeId: 'session:s1',
            subagentId: 'execution_run:run_1',
        });
        const textTree = JSON.stringify(tree!.toJSON());
        expect(textTree).toContain('Subagent · Codex');
    });
});
