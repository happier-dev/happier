import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeAll, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (_: any) => 1 },
    AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
    ActivityIndicator: 'ActivityIndicator',
    View: 'View',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                surfaceHigh: '#f5f5f5',
                divider: '#eee',
                text: '#000',
                textSecondary: '#666',
            },
        },
    }),
    StyleSheet: { create: (value: any) => value },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'Text',
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useLocalSetting: (key: string) => {
        if (key === 'editorFocusModeEnabled') return false;
        return null;
    },
    useLocalSettingMutable: () => [false, vi.fn()],
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
                        subtitle: 'Happier subagent · Codex',
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
        await act(async () => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        expect(tree).toBeTruthy();
        expect(subagentViewSpy).toHaveBeenCalledTimes(1);
        expect(subagentViewSpy.mock.calls[0]?.[0]).toMatchObject({
            sessionId: 's1',
            scopeId: 'session:s1',
            subagentId: 'execution_run:run_1',
        });
        const textTree = JSON.stringify(tree!.toJSON());
        expect(textTree).toContain('Happier subagent · Codex');
    });
});
