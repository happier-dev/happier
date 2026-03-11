import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (_: any) => 1 },
    ActivityIndicator: 'ActivityIndicator',
    View: 'View',
    Pressable: 'Pressable',
    ScrollView: 'ScrollView',
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

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => React.createElement('SessionCommitDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: () => React.createElement('SessionFileDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionScmReviewDetailsView', () => ({
    SessionScmReviewDetailsView: () => React.createElement('SessionScmReviewDetailsView'),
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

describe('SessionDetailsPanel (terminal resource)', () => {
    it('renders SessionEmbeddedTerminalPane for terminal tabs', async () => {
        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');
        terminalViewSpy.mockClear();

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        expect(tree).toBeTruthy();
        expect(terminalViewSpy).toHaveBeenCalledTimes(1);
        expect(terminalViewSpy.mock.calls[0]?.[0]?.sessionId).toBe('s1');
        expect(terminalViewSpy.mock.calls[0]?.[0]?.currentDockLocation).toBe('details');
    });
});
