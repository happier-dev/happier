import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const stub = await import('@/dev/reactNativeStub');
    return {
        ...stub,
        Platform: { OS: 'web', select: (value: any) => value?.web ?? value?.default ?? null },
    };
});

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

        const findHostSurfaceView = (testID: string) => {
            return tree!.root.find((node) => (node.type as unknown) === 'View' && node.props?.testID === testID);
        };
        const getStyleValue = (node: renderer.ReactTestInstance, key: string) => {
            const style = node.props.style;
            const styles = Array.isArray(style) ? style : [style];
            for (const entry of styles) {
                if (entry && typeof entry === 'object' && key in entry) {
                    return (entry as Record<string, unknown>)[key];
                }
            }
            return undefined;
        };

        expect(tree!.root.findAllByType('SessionRightPanelGitView')).toHaveLength(1);
        // Lazy-mount inactive tabs for faster initial open.
        expect(tree!.root.findAllByType('SessionRepositoryTreeBrowserView')).toHaveLength(0);

        await act(async () => {
            const filesTab = tree!.root.findByProps({ testID: 'session-rightpanel-tab:files' });
            filesTab.props.onPress();
        });

        expect(tree!.root.findAllByType('SessionRightPanelGitView')).toHaveLength(1);
        expect(tree!.root.findAllByType('SessionRepositoryTreeBrowserView')).toHaveLength(1);
        const repositoryTree = tree!.root.findByType('SessionRepositoryTreeBrowserView');
        expect(repositoryTree).toBeTruthy();
        expect(getStyleValue(findHostSurfaceView('session-rightpanel-surface-git'), 'visibility')).toBe('hidden');
        expect(getStyleValue(findHostSurfaceView('session-rightpanel-surface-files'), 'visibility')).toBe('visible');

        // Switching back keeps both mounted.
        await act(async () => {
            const gitTab = tree!.root.findByProps({ testID: 'session-rightpanel-tab:git' });
            gitTab.props.onPress();
        });
        expect(tree!.root.findAllByType('SessionRightPanelGitView')).toHaveLength(1);
        expect(tree!.root.findAllByType('SessionRepositoryTreeBrowserView')).toHaveLength(1);
        expect(getStyleValue(findHostSurfaceView('session-rightpanel-surface-git'), 'visibility')).toBe('visible');
        expect(getStyleValue(findHostSurfaceView('session-rightpanel-surface-files'), 'visibility')).toBe('hidden');
    });
});
