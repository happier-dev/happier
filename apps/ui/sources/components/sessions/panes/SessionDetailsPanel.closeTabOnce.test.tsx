import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (_: any) => 1 },
    ActivityIndicator: 'ActivityIndicator',
    View: React.forwardRef((props: any, ref: any) => React.createElement('View', { ...props, ref }, props.children)),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    ScrollView: (props: any) => React.createElement('ScrollView', props, props.children),
    Dimensions: { get: () => ({ width: 1200, height: 800, scale: 2, fontScale: 1 }) },
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
                shadow: { color: '#000', opacity: 0.2 },
                accent: {
                    indigo: '#5C6BC0',
                    orange: '#FF9500',
                },
            },
        },
    }),
    StyleSheet: {
        absoluteFillObject: {},
        create: (value: any) =>
            typeof value === 'function'
                ? value({
                    colors: {
                        surface: '#fff',
                        surfaceHigh: '#f5f5f5',
                        divider: '#eee',
                        text: '#000',
                        textSecondary: '#666',
                        shadow: { color: '#000', opacity: 0.2 },
                        accent: {
                            indigo: '#5C6BC0',
                            orange: '#FF9500',
                        },
                    },
                })
                : value,
    },
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

vi.mock('@/components/sessions/files/views/SessionFileDetailsView', () => ({
    SessionFileDetailsView: () => React.createElement('SessionFileDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionCommitDetailsView', () => ({
    SessionCommitDetailsView: () => React.createElement('SessionCommitDetailsView'),
}));

vi.mock('@/components/sessions/files/views/SessionScmReviewDetailsView', () => ({
    SessionScmReviewDetailsView: () => React.createElement('SessionScmReviewDetailsView'),
}));

vi.mock('@/components/sessions/terminal/SessionEmbeddedTerminalPane', () => ({
    SessionEmbeddedTerminalPane: () => React.createElement('SessionEmbeddedTerminalPane'),
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

let mockAppPaneScope: any = null;
vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => mockAppPaneScope,
}));

describe('SessionDetailsPanel (close tab)', () => {
    it('closes a tab exactly once when clicking its close button', async () => {
        const closeDetailsTabSpy = vi.fn();

        mockAppPaneScope = {
            closeDetails: vi.fn(),
            closeDetailsTab: closeDetailsTabSpy,
            pinDetailsTab: vi.fn(),
            setActiveDetailsTab: vi.fn(),
            scopeState: {
                details: {
                    isOpen: true,
                    activeTabKey: 'file:a',
                    tabs: [
                        { key: 'file:a', kind: 'file', title: 'a.txt', isPinned: true, isPreview: false, resource: { kind: 'file', path: 'a.txt' } },
                    ],
                },
            },
        };

        const { SessionDetailsPanel } = await import('./SessionDetailsPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionDetailsPanel sessionId="s1" scopeId="session:s1" />);
        });

        const closeButtons = tree!.root
            .findAllByProps({ accessibilityLabel: 'session.detailsPanel.closeTabA11y' })
            // Filter out composite wrapper nodes created by our react-native test doubles.
            .filter((node) => typeof node.type === 'string');
        expect(closeButtons.length).toBe(1);

        await act(async () => {
            closeButtons[0]!.props.onPress({ stopPropagation: () => {} });
        });

        expect(closeDetailsTabSpy).toHaveBeenCalledTimes(1);
        expect(closeDetailsTabSpy).toHaveBeenCalledWith('file:a');
    });
});
