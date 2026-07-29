import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let translationPrefix = 'en';
const sessionMetadataState = vi.hoisted(() => ({
    metadata: { flavor: 'codex' } as Record<string, unknown> | null,
    metadataLayoutVersion: 0,
    ownerMetadataView: null as Record<string, unknown> | null,
    accessLevel: null as 'view' | 'edit' | 'admin' | null,
}));
const scmState = vi.hoisted(() => ({
    status: null as Record<string, unknown> | null,
}));
const badgeSettingsState = vi.hoisted(() => ({
    gitBadgeMode: 'changedFiles' as 'changedFiles' | 'diffLines' | 'off',
    openTabs: true,
}));

installNavigationCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Animated: {
                Value: class {
                    _value: number;
                    constructor(value: number) {
                        this._value = value;
                    }
                    setValue(value: number) {
                        this._value = value;
                    }
                    interpolate(config: Record<string, unknown>) {
                        return { __type: 'interpolate', value: this._value, config };
                    }
                },
                timing: vi.fn(() => ({
                    start: (cb?: (result: { finished: boolean }) => void) => cb?.({ finished: true }),
                })),
                View: ({ children, ...props }: any) => React.createElement('AnimatedView', props, children),
            },
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
        useSessionMetadata: () => sessionMetadataState.metadata,
        useSession: () => ({
            id: 'sess_1',
            metadata: sessionMetadataState.metadata,
            metadataLayoutVersion: sessionMetadataState.metadataLayoutVersion,
            ownerMetadataView: sessionMetadataState.ownerMetadataView,
            accessLevel: sessionMetadataState.accessLevel,
        }),
        useSessionProjectScmStatus: () => scmState.status,
        useSetting: (key: string) => {
            if (key === 'tabBarGitBadgeMode') return badgeSettingsState.gitBadgeMode;
            if (key === 'tabBarOpenTabsBadgeEnabled') return badgeSettingsState.openTabs;
            if (key === 'tabBarShowLabels') return true;
            if (key === 'tabBarSize') return 'regular';
            return undefined;
        },
    }),
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

describe('cockpit tab bars', () => {
    afterEach(() => {
        translationPrefix = 'en';
        sessionMetadataState.metadata = { flavor: 'codex' };
        sessionMetadataState.metadataLayoutVersion = 0;
        sessionMetadataState.ownerMetadataView = null;
        sessionMetadataState.accessLevel = null;
        scmState.status = null;
        badgeSettingsState.gitBadgeMode = 'changedFiles';
        badgeSettingsState.openTabs = true;
    });

    it('uses the session agent name and icon for the chat tab', async () => {
        sessionMetadataState.metadata = { flavor: 'codex' };
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

        expect(screen.getTextContent()).toContain('en:agentInput.agent.codex');
        const icon = screen.findByTestId('session-cockpit-tab-chat-agent-icon');
        expect(icon?.props.agentId).toBe('codex');
    });

    it('uses strict shared Agent presentation for a layout1 owner', async () => {
        sessionMetadataState.metadataLayoutVersion = 1;
        sessionMetadataState.metadata = {
            v: 1,
            agentPresentation: { agentId: 'opencode' },
        };
        sessionMetadataState.ownerMetadataView = {
            flavor: 'claude',
        };
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-chat-agent-icon')?.props.agentId).toBe('opencode');
    });

    it('uses only strict shared Agent presentation for a layout1 participant', async () => {
        sessionMetadataState.metadataLayoutVersion = 1;
        sessionMetadataState.accessLevel = 'view';
        sessionMetadataState.metadata = {
            v: 1,
            agentPresentation: { agentId: 'claude' },
        };
        sessionMetadataState.ownerMetadataView = null;
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-chat-agent-icon')?.props.agentId).toBe('claude');
    });

    it('shows a changed-files count badge by default when the session is dirty', async () => {
        scmState.status = { isDirty: true, modifiedCount: 3, linesAdded: 42, linesRemoved: 8 };
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
        badgeSettingsState.gitBadgeMode = 'diffLines';
        scmState.status = { isDirty: true, modifiedCount: 3, linesAdded: 42, linesRemoved: 8 };
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
        badgeSettingsState.gitBadgeMode = 'off';
        scmState.status = { isDirty: true, modifiedCount: 3, linesAdded: 42, linesRemoved: 8 };
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
        scmState.status = { isDirty: false, modifiedCount: 0, linesAdded: 0, linesRemoved: 0 };
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

    it('hides the open-tab count badge when disabled in settings', async () => {
        badgeSettingsState.openTabs = false;
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

    it('renders Browser and Services as first-class session cockpit tabs', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const pressed: string[] = [];

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="browser"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={(surface) => pressed.push(surface)}
            />,
        );

        const browserTab = screen.findByTestId('session-cockpit-tab-browser');
        const servicesTab = screen.findByTestId('session-cockpit-tab-services');
        expect(browserTab?.props.accessibilityRole).toBe('tab');
        expect(browserTab?.props.accessibilityLabel).toBe('en:browserSurface.title');
        expect(browserTab?.props.accessibilityState).toEqual({ selected: true });
        expect(servicesTab?.props.accessibilityRole).toBe('tab');
        expect(servicesTab?.props.accessibilityLabel).toBe('en:localServices.inventory.title');
        expect(servicesTab?.props.accessibilityState).toEqual({ selected: false });

        await act(async () => {
            servicesTab?.props.onPress();
        });

        expect(pressed).toEqual(['services']);
    });

    it('keeps Browser and Services visible alongside existing session cockpit tabs', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={true}
                openDetailsTabCount={2}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-chat')).toBeTruthy();
        expect(screen.findByTestId('session-cockpit-tab-browse')).toBeTruthy();
        expect(screen.findByTestId('session-cockpit-tab-git')).toBeTruthy();
        expect(screen.findByTestId('session-cockpit-tab-navigation')).toBeTruthy();
        expect(screen.findByTestId('session-cockpit-tab-tabs')).toBeTruthy();
        expect(screen.findByTestId('session-cockpit-tab-browser')).toBeTruthy();
        expect(screen.findByTestId('session-cockpit-tab-services')).toBeTruthy();
        expect(screen.findByTestId('session-cockpit-tab-terminal')).toBeTruthy();
    });

    it('offers the transcript navigation surface as a session cockpit tab', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');
        const pressed: string[] = [];

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={false}
                openDetailsTabCount={0}
                onSurfacePress={(surface) => pressed.push(surface)}
            />,
        );

        const navigationTab = screen.findByTestId('session-cockpit-tab-navigation');
        expect(navigationTab?.props.accessibilityRole).toBe('tab');
        expect(navigationTab?.props.accessibilityLabel).toBe('en:session.transcriptNavigation.title');
        expect(navigationTab?.props.accessibilityState).toEqual({ selected: false });

        await act(async () => {
            navigationTab?.props.onPress();
        });

        expect(pressed).toEqual(['navigation']);
    });

    it('never offers the desktop-only agents tab as a session cockpit surface', async () => {
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

        expect(screen.findByTestId('session-cockpit-tab-agents')).toBeNull();
    });

    it('does not render a session cockpit active pill overlay', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-active-pill')).toBeNull();
    });

    it('does not render a project cockpit active pill overlay', async () => {
        const { ProjectCockpitTabBar } = await import('./ProjectCockpitTabBar');

        const screen = await renderScreen(
            <ProjectCockpitTabBar
                workspaceRefId="wr_1"
                activeSurface="terminal"
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('project-cockpit-active-pill')).toBeNull();
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
        expect(screen.getTextContent()).toContain('fr:common.tabs');
        expect(screen.getTextContent()).toContain('fr:session.rightPanel.tabs.git');
        expect(screen.getTextContent()).not.toContain('fr:common.details');
    });

    it('refreshes project tab labels when the language changes and the bar rerenders', async () => {
        translationPrefix = 'en';
        const { ProjectCockpitTabBar } = await import('./ProjectCockpitTabBar');

        const screen = await renderScreen(
            <ProjectCockpitTabBar
                workspaceRefId="wr_1"
                activeSurface="overview"
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('en:common.files');

        translationPrefix = 'fr';
        await act(async () => {
            await screen.update(
                <ProjectCockpitTabBar
                    workspaceRefId="wr_1"
                    activeSurface="overview"
                    onSurfacePress={() => {}}
                />,
            );
        });

        expect(screen.getTextContent()).toContain('fr:common.files');
        expect(screen.getTextContent()).toContain('fr:common.tabs');
        expect(screen.getTextContent()).toContain('fr:session.rightPanel.tabs.git');
        expect(screen.getTextContent()).not.toContain('fr:common.details');
    });

    it('exposes the selected state on the active cockpit tab', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={true}
                openDetailsTabCount={0}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-git')?.props.accessibilityRole).toBe('tab');
        expect(screen.findByTestId('session-cockpit-tab-git')?.props.accessibilityLabel).toBe('en:session.rightPanel.tabs.git');
        expect(screen.findByTestId('session-cockpit-tab-browse')?.props.accessibilityLabel).toBe('en:common.files');
        expect(screen.findByTestId('session-cockpit-tab-git')?.props.accessibilityState).toEqual({ selected: true });
        expect(screen.findByTestId('session-cockpit-tab-browse')?.props.accessibilityState).toEqual({ selected: false });
    }, 120_000);
});
