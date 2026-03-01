import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    Platform: { OS: 'web', select: (value: any) => value?.default ?? null },
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
    Text: (props: any) => React.createElement('Text', props, props.children),
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

const suspendPromise = new Promise<void>(() => {
    // never resolves: we want to verify the Suspense fallback path
});
vi.mock('@/components/sessions/panes/git/SessionRightPanelGitView', () => ({
    SessionRightPanelGitView: () => {
        throw suspendPromise;
    },
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

describe('SessionRightPanel (suspense fallback)', () => {
    it('renders a loading fallback when the active tab suspends', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);
        });

        // When the active tab suspends, we should still render a visible loading indicator.
        expect(tree!.root.findAllByType('ActivityIndicator' as any).length).toBeGreaterThan(0);
    });
});
