import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let translationPrefix = 'en';
let sessionState: { metadata?: Record<string, unknown> | null } | null = {
    metadata: { flavor: 'codex' },
};
let scmState: Record<string, unknown> | null = null;
let gitBadgeMode: 'changedFiles' | 'diffLines' | 'off' = 'changedFiles';
let openTabsBadgeEnabled = true;
const themeState = vi.hoisted(() => ({
    textPrimaryColor: '#111111',
}));
type LateralTarget = { sessionId: string; title: string; position: number; total: number } | null;
const lateralNavigationState = vi.hoisted(() => ({
    previous: null as LateralTarget,
    next: null as LateralTarget,
    navigate: vi.fn(),
}));

vi.mock('../lateralSwipe/useSessionCockpitLateralNavigation', () => ({
    useSessionCockpitLateralNavigation: () => ({
        previous: lateralNavigationState.previous,
        next: lateralNavigationState.next,
        navigate: lateralNavigationState.navigate,
    }),
}));

installNavigationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => `${translationPrefix}:${key}`,
            translateLoose: (key: string) => `${translationPrefix}:${key}`,
            getPreferredLanguage: () => translationPrefix,
        });
    },
    storage: async () => ({
        useSessionMetadata: () => sessionState?.metadata ?? null,
        useSessionProjectScmStatus: () => scmState,
        useSetting: (key: string) => {
            if (key === 'tabBarGitBadgeMode') return gitBadgeMode;
            if (key === 'tabBarOpenTabsBadgeEnabled') return openTabsBadgeEnabled;
            if (key === 'tabBarShowLabels') return true;
            if (key === 'tabBarSize') return 'regular';
            return undefined;
        },
    }),
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    text: {
                        primary: themeState.textPrimaryColor,
                    },
                },
            },
        });
    },
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('expo-blur', () => ({
    BlurView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
        React.createElement('BlurView', props, children),
}));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 960 },
}));

function styleObjects(style: unknown): Record<string, unknown>[] {
    const styles = Array.isArray(style) ? style : [style];
    return styles.filter((value): value is Record<string, unknown> => Boolean(value) && typeof value === 'object');
}

describe('cockpit tab bars', () => {
    beforeEach(() => {
        vi.resetModules();
        themeState.textPrimaryColor = 'var(--colors-text-primary)';
    });

    afterEach(() => {
        translationPrefix = 'en';
        sessionState = { metadata: { flavor: 'codex' } };
        scmState = null;
        gitBadgeMode = 'changedFiles';
        openTabsBadgeEnabled = true;
    });

    it('offers the lateral step as an accessibility action on every cockpit tab', async () => {
        // The band's own container is `pointerEvents="box-none"` and is not an accessibility
        // element, so actions placed there never reach the VoiceOver rotor or the TalkBack
        // context menu. A tab is the only focusable thing in the band, so the actions ride
        // the tabs — the same shape `SessionItem` uses for its row actions.
        //
        // The bar's contract here is PLACEMENT: given navigable neighbours, expose named
        // actions on focusable elements. Resolving those neighbours belongs to
        // `useSessionCockpitLateralNavigation` and is proven in its own suite, so it is
        // stubbed rather than dragged in through the whole storage surface.
        lateralNavigationState.previous = { sessionId: 'sess_0', title: 'Previous', position: 1, total: 3 };
        lateralNavigationState.next = { sessionId: 'sess_2', title: 'Next', position: 3, total: 3 };

        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        const tabs = screen.tree.root.findAll((node) => (
            typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('session-cockpit-tab-')
            && Array.isArray(node.props?.accessibilityActions)
        ));
        expect(tabs.length).toBeGreaterThan(0);
        for (const tab of tabs) {
            expect((tab.props.accessibilityActions as Array<{ name: string }>).map((a) => a.name))
                .toEqual(['previousSession', 'nextSession']);
            // An action is only operable if the element carrying it is also named.
            expect(typeof tab.props.accessibilityLabel).toBe('string');
        }
    });

    it('offers no lateral accessibility action when there is no neighbour to step to', async () => {
        lateralNavigationState.previous = null;
        lateralNavigationState.next = null;

        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        const tabsWithActions = screen.tree.root.findAll((node) => (
            typeof node.props?.testID === 'string'
            && node.props.testID.startsWith('session-cockpit-tab-')
            && node.props?.accessibilityActions !== undefined
        ));
        expect(tabsWithActions).toHaveLength(0);
    });

    it('keeps the active pill linked to CSS variable theme colors', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        const activePills = screen.tree.root.findAll((node) => (
            node.props?.pointerEvents === 'none'
            && styleObjects(node.props.style).some((style) => (
                style.backgroundColor === 'var(--colors-text-primary)'
                && style.opacity === 0.05
            ))
        ));
        expect(activePills.length).toBeGreaterThan(0);
    });

    it('renders session surfaces and omits terminal when unavailable', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tabbar-sess_1')).not.toBeNull();
        expect(screen.findByTestId('session-cockpit-tab-git')).not.toBeNull();
        expect(screen.findByTestId('session-cockpit-tab-terminal')).toBeNull();
    });

    it('shows a changed-files count badge by default when the session is dirty', async () => {
        scmState = { isDirty: true, modifiedCount: 3, linesAdded: 42, linesRemoved: 8 };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-git-badge')).not.toBeNull();
        const content = screen.getTextContent();
        expect(content).toContain('3');
        expect(content).not.toContain('+42');
    });

    it('shows the added/removed line chip when git badge mode is diffLines', async () => {
        gitBadgeMode = 'diffLines';
        scmState = { isDirty: true, modifiedCount: 3, linesAdded: 42, linesRemoved: 8 };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        const content = screen.getTextContent();
        expect(content).toContain('+42');
        expect(content).toContain('8');
    });

    it('hides the git badge when git badge mode is off', async () => {
        gitBadgeMode = 'off';
        scmState = { isDirty: true, modifiedCount: 3, linesAdded: 42, linesRemoved: 8 };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-git-badge')).toBeNull();
    });

    it('omits the git badge for a clean working tree', async () => {
        scmState = { isDirty: false, modifiedCount: 0, linesAdded: 0, linesRemoved: 0 };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-git-badge')).toBeNull();
    });

    it('shows an open-tab count badge on the tabs surface', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="tabs"
                terminalTabAvailable={false}
                openDetailsTabCount={4}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-tabs-badge')).not.toBeNull();
        expect(screen.getTextContent()).toContain('4');
    });

    it('hides the open-tab count badge when disabled in settings', async () => {
        openTabsBadgeEnabled = false;
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="tabs"
                terminalTabAvailable={false}
                openDetailsTabCount={4}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-tabs-badge')).toBeNull();
    });

    it('labels the chat surface with the current session agent and renders its provider logo', async () => {
        sessionState = { metadata: { flavor: 'claude' } };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('en:agentInput.agent.claude');
        const icon = screen.findByType('AgentIcon' as never);
        expect(icon.props.agentId).toBe('claude');
        expect(icon.props.testID).toBe('session-cockpit-tab-chat-agent-icon');
    });

    it('refreshes session tab labels when the language changes and the bar rerenders', async () => {
        translationPrefix = 'en';
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('en:common.files');
        expect(screen.getTextContent()).toContain('en:agentInput.agent.codex');

        translationPrefix = 'fr';
        await act(async () => {
            await screen.update(
                <SessionCockpitTabBar
                    sessionId="sess_1"
                    activeSurface="chat"
                    terminalTabAvailable={true}
                    openDetailsTabCount={0}
                    onSurfacePress={() => {}}
                />,
            );
        });

        expect(screen.getTextContent()).toContain('fr:common.files');
        expect(screen.getTextContent()).toContain('fr:agentInput.agent.codex');
        expect(screen.getTextContent()).toContain('fr:session.rightPanel.tabs.git');
        expect(screen.getTextContent()).toContain('fr:workspaceCockpit.tabs');
        expect(screen.getTextContent()).not.toContain('fr:common.details');
    });
});
