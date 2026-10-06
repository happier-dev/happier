import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen as renderPanelScreen, type RenderScreenResult } from '@/dev/testkit';
import { installSessionDetailsPanelCommonModuleMocks } from './sessionDetailsPanelTestHelpers';

let initialTabId = 'git';

installSessionDetailsPanelCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: 'View',
            Pressable: 'Pressable',
            ActivityIndicator: 'ActivityIndicator',
            AppState: {
                currentState: 'active',
                addEventListener: () => ({ remove: () => {} }),
            },
            Platform: {
                select: () => 1,
            },
        });
    },
    icons: async () => {
        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return createExpoVectorIconsMock();
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
});

// Typography is the real type scale (plain constants), not a partial stub that drifts from it.

function findHostByTestId(screen: RenderScreenResult, testID: string) {
    return screen.findAllByTestId(testID).find((node) => typeof node.type === 'string') ?? null;
}

function getStyleValue(style: unknown, key: string): unknown {
    const styles = Array.isArray(style) ? style : [style];
    for (const entry of styles) {
        if (entry && typeof entry === 'object' && key in entry) {
            return (entry as Record<string, unknown>)[key];
        }
    }
    return undefined;
}

import { installSessionPaneRuntimeTestHarness } from './sessionPaneRuntimeTestHarness';
const runtime = installSessionPaneRuntimeTestHarness();
async function renderScreen(element: React.ReactElement) {
    const screen = await renderPanelScreen(<runtime.Wrapper>{element}</runtime.Wrapper>);
    await act(async () => runtime.pane.openRight({ tabId: initialTabId }));
    return screen;
}

describe('SessionRightPanel (core tabs)', () => {
    beforeEach(() => {
        initialTabId = 'git';
        vi.clearAllMocks();
    });

    it('renders git, files, navigation, agents, and services tabs and shows the git surface by default', async () => {
        const { SessionRightPanel } = await import('./SessionRightPanel');

        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        expect(screen.findByTestId('session-rightpanel-tab:git')).toBeTruthy();
        expect(screen.findByTestId('session-rightpanel-tab:files')).toBeTruthy();
        expect(screen.findByTestId('session-rightpanel-tab:navigation')).toBeTruthy();
        expect(screen.findByTestId('session-rightpanel-tab:agents')).toBeTruthy();
        expect(screen.findByTestId('session-rightpanel-tab:browser')).toBeNull();
        expect(screen.findByTestId('session-rightpanel-tab:services')).toBeTruthy();
        expect(screen.findByTestId('session-rightpanel-tab:reviews')).toBeNull();
        expect(screen.findByTestId('session-rightpanel-tab:terminal')).toBeNull();

        const gitSurface = findHostByTestId(screen, 'session-rightpanel-surface-git');
        expect(gitSurface).not.toBeNull();
        expect(gitSurface?.props.pointerEvents).toBe('auto');
        expect(findHostByTestId(screen, 'session-rightpanel-surface-files')).toBeNull();
        expect(findHostByTestId(screen, 'session-rightpanel-surface-navigation')).toBeNull();
        expect(findHostByTestId(screen, 'session-rightpanel-surface-agents')).toBeNull();
        expect(findHostByTestId(screen, 'session-rightpanel-surface-reviews')).toBeNull();
    });

    it('renders the transcript navigation surface when the navigation tab is active', async () => {
        initialTabId = 'navigation';
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const { SessionTranscriptNavigationPane } = await import('./SessionTranscriptNavigationPane');

        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        const navigationSurface = findHostByTestId(screen, 'session-rightpanel-surface-navigation');
        expect(navigationSurface).not.toBeNull();
        expect(navigationSurface?.props.pointerEvents).toBe('auto');
        expect(screen.findAllByType(SessionTranscriptNavigationPane)).toHaveLength(1);
        expect(screen.findByType(SessionTranscriptNavigationPane)?.props.sessionId).toBe('s1');
        expect(findHostByTestId(screen, 'session-rightpanel-surface-git')).toBeNull();
        expect(findHostByTestId(screen, 'session-rightpanel-surface-files')).toBeNull();
        expect(findHostByTestId(screen, 'session-rightpanel-surface-agents')).toBeNull();
    });

    it('only asks the navigation pane to reveal the transcript when this panel replaces it', async () => {
        initialTabId = 'navigation';
        const { SessionRightPanel } = await import('./SessionRightPanel');
        const { SessionTranscriptNavigationPane } = await import('./SessionTranscriptNavigationPane');

        // Desktop pane: the transcript is mounted beside this panel, so a jump must not
        // close the reader's navigation list to "reveal" something already visible.
        const beside = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);
        expect(beside.findByType(SessionTranscriptNavigationPane)?.props.onRevealTranscript).toBeUndefined();

        // Mobile screen presentation: this panel IS the route, the transcript is another one.
        const onRequestClose = vi.fn();
        const asScreen = await renderScreen(
            <SessionRightPanel
                sessionId="s1"
                scopeId="session:s1"
                presentation="screen"
                onRequestClose={onRequestClose}
            />,
        );
        const reveal = asScreen.findByType(SessionTranscriptNavigationPane)?.props.onRevealTranscript;
        expect(typeof reveal).toBe('function');
        (reveal as () => void)();
        expect(onRequestClose).toHaveBeenCalledTimes(1);
    });

    it('keeps a single agents surface test id when the agents tab is active', async () => {
        initialTabId = 'agents';
        const { SessionRightPanel } = await import('./SessionRightPanel');

        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        const agentsSurface = findHostByTestId(screen, 'session-rightpanel-surface-agents');
        expect(agentsSurface).not.toBeNull();
        expect(agentsSurface?.props.pointerEvents).toBe('auto');
        expect(findHostByTestId(screen, 'session-rightpanel-surface-git')).toBeNull();
        expect(findHostByTestId(screen, 'session-rightpanel-surface-files')).toBeNull();
    });

    it('uses git as an in-memory default when persisted pane state points at an unregistered tab', async () => {
        initialTabId = 'reviews';
        const { SessionRightPanel } = await import('./SessionRightPanel');

        const screen = await renderScreen(<SessionRightPanel sessionId="s1" scopeId="session:s1" />);

        const gitSurface = findHostByTestId(screen, 'session-rightpanel-surface-git');
        expect(gitSurface).not.toBeNull();
        expect(gitSurface?.props.pointerEvents).toBe('auto');
        expect(runtime.pane.scopeState?.right.activeTabId).toBe('reviews');
        expect(findHostByTestId(screen, 'session-rightpanel-surface-files')).toBeNull();
        expect(findHostByTestId(screen, 'session-rightpanel-surface-agents')).toBeNull();
        expect(findHostByTestId(screen, 'session-rightpanel-surface-reviews')).toBeNull();
    });
});
