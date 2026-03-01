import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { select: (value: any) => value?.default ?? null },
    View: (props: any) => React.createElement('View', props, props.children),
    Pressable: (props: any) => React.createElement('Pressable', props, props.children),
    ActivityIndicator: (props: any) => React.createElement('ActivityIndicator', props),
}));

vi.mock('react-native-unistyles', () => ({
    __esModule: true,
    useUnistyles: () => ({
        theme: {
            colors: {
                surface: '#fff',
                surfaceHigh: '#f6f6f6',
                divider: '#ddd',
                text: '#000',
                textSecondary: '#666',
            },
        },
    }),
    StyleSheet: {
        create: (value: any) =>
            typeof value === 'function'
                ? value({
                    colors: {
                        surface: '#fff',
                        surfaceHigh: '#f6f6f6',
                        divider: '#ddd',
                        text: '#000',
                        textSecondary: '#666',
                    },
                })
                : value,
    },
}));

vi.mock('@expo/vector-icons', () => ({
    Octicons: 'Octicons',
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

vi.mock('@/components/sessions/files/views/SessionRepositoryTreeBrowserView', () => ({
    SessionRepositoryTreeBrowserView: (props: any) => React.createElement('SessionRepositoryTreeBrowserView', props),
}));

vi.mock('@/components/sessions/panes/git/SessionRightPanelGitView', () => ({
    SessionRightPanelGitView: (props: any) => React.createElement('SessionRightPanelGitView', props),
}));

const scopeState: any = {
    right: {
        isOpen: true,
        activeTabId: 'git',
    },
};

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => {
        const [, bump] = React.useState(0);
        return {
            scopeState,
            openRight: vi.fn(),
            setRightTab: (tabId: string) => {
                scopeState.right.activeTabId = tabId;
                bump((v) => v + 1);
            },
            closeRight: vi.fn(),
            openDetailsTab: vi.fn(),
        };
    },
}));

describe('SessionRightPanel (keep mounted tabs)', () => {
    it('keeps Git and Files tab surfaces mounted so switching tabs preserves state', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);
        });

        expect(tree!.root.findAllByType('SessionRightPanelGitView')).toHaveLength(1);
        // Lazy-mount inactive tabs for faster initial open.
        expect(tree!.root.findAllByType('SessionRepositoryTreeBrowserView')).toHaveLength(0);

        await act(async () => {
            const filesTab = tree!.root.findByProps({ testID: 'session-rightpanel-tab-files' });
            filesTab.props.onPress();
        });

        expect(tree!.root.findAllByType('SessionRightPanelGitView')).toHaveLength(1);
        expect(tree!.root.findAllByType('SessionRepositoryTreeBrowserView')).toHaveLength(1);

        // Switching back keeps both mounted.
        await act(async () => {
            const gitTab = tree!.root.findByProps({ testID: 'session-rightpanel-tab-git' });
            gitTab.props.onPress();
        });
        expect(tree!.root.findAllByType('SessionRightPanelGitView')).toHaveLength(1);
        expect(tree!.root.findAllByType('SessionRepositoryTreeBrowserView')).toHaveLength(1);
    });
});
