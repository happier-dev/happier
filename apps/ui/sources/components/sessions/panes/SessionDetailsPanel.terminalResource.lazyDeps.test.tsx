import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (_: any) => 1 },
    View: 'View',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
    ActivityIndicator: 'ActivityIndicator',
    AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
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

const terminalViewSpy = vi.fn();
vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: (props: any) => {
        terminalViewSpy(props);
        return React.createElement('SessionEmbeddedTerminalPane');
    },
}));

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => {
    throw new Error('commit details view should not be imported for terminal-only details rendering');
});

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => {
    throw new Error('file details view should not be imported for terminal-only details rendering');
});

vi.mock('@/components/sessions/files/views/SessionScmReviewDetailsView', () => {
    throw new Error('scm review details view should not be imported for terminal-only details rendering');
});

vi.mock('@/components/sessions/files/views/SessionScmStashDetailsView', () => {
    throw new Error('scm stash details view should not be imported for terminal-only details rendering');
});

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        closeDetails: vi.fn(),
        closeDetailsTab: vi.fn(),
        pinDetailsTab: vi.fn(),
        setActiveDetailsTab: vi.fn(),
        scopeState: {
            details: {
                isOpen: true,
                activeTabKey: 'terminal:embedded',
                tabs: [
                    {
                        key: 'terminal:embedded',
                        kind: 'terminal',
                        title: 'Terminal',
                        isPinned: true,
                        isPreview: false,
                        resource: { kind: 'terminal' },
                    },
                ],
            },
        },
    }),
}));

describe('SessionDetailsPanel (terminal resource lazy deps)', () => {
    afterEach(() => {
        vi.clearAllMocks();
    });

    it('renders terminal details without importing heavy non-terminal detail views', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        terminalViewSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        expect(tree).toBeTruthy();
        expect(terminalViewSpy).toHaveBeenCalledTimes(1);
    });
});
