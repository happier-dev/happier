import * as React from 'react';
import type { ReactTestInstance } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async (importOriginal) => {
        const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
        return {
            ...actual,
            useSettings: () => ({}),
        };
    },
});

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

        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        const getStyleValue = (node: ReactTestInstance, key: string) => {
            const styles = Array.isArray(node.props.style) ? node.props.style : [node.props.style];
            for (const entry of styles) {
                if (entry && typeof entry === 'object' && key in entry) {
                    return (entry as Record<string, unknown>)[key];
                }
            }
            return undefined;
        };

        expect(screen.findAllByType('SessionRightPanelGitView')).toHaveLength(1);
        // Lazy-mount inactive tabs for faster initial open.
        expect(screen.findAllByType('SessionRepositoryTreeBrowserView')).toHaveLength(0);

        await screen.pressByTestIdAsync('session-rightpanel-tab:files');

        expect(screen.findAllByType('SessionRightPanelGitView')).toHaveLength(1);
        expect(screen.findAllByType('SessionRepositoryTreeBrowserView')).toHaveLength(1);
        expect(screen.findByType('SessionRepositoryTreeBrowserView')).toBeTruthy();
        expect(screen.findByTestId('session-rightpanel-surface-git')!.props.pointerEvents).toBe('none');
        expect(getStyleValue(screen.findByTestId('session-rightpanel-surface-git')!, 'opacity')).toBe(0);
        expect(screen.findByTestId('session-rightpanel-surface-files')!.props.pointerEvents).toBe('auto');
        expect(getStyleValue(screen.findByTestId('session-rightpanel-surface-files')!, 'opacity')).toBe(1);

        // Switching back keeps both mounted.
        await screen.pressByTestIdAsync('session-rightpanel-tab:git');
        expect(screen.findAllByType('SessionRightPanelGitView')).toHaveLength(1);
        expect(screen.findAllByType('SessionRepositoryTreeBrowserView')).toHaveLength(1);
        expect(screen.findByTestId('session-rightpanel-surface-git')!.props.pointerEvents).toBe('auto');
        expect(getStyleValue(screen.findByTestId('session-rightpanel-surface-git')!, 'opacity')).toBe(1);
        expect(screen.findByTestId('session-rightpanel-surface-files')!.props.pointerEvents).toBe('none');
        expect(getStyleValue(screen.findByTestId('session-rightpanel-surface-files')!, 'opacity')).toBe(0);
    });
});
