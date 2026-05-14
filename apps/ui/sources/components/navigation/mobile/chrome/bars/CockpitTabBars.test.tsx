import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { installNavigationCommonModuleMocks } from '@/components/ui/navigation/navigationTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let translationPrefix = 'en';
const sessionMetadataState = vi.hoisted(() => ({
    metadata: { flavor: 'codex' } as Record<string, unknown> | null,
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
    }),
});

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('@/agents/registry/AgentIcon', () => ({
    AgentIcon: (props: Record<string, unknown>) => React.createElement('AgentIcon', props),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 960 },
}));

describe('cockpit tab bars', () => {
    it('uses the session agent name and icon for the chat tab', async () => {
        sessionMetadataState.metadata = { flavor: 'codex' };
        translationPrefix = 'en';
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="chat"
                terminalTabAvailable={true}
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.getTextContent()).toContain('en:agentInput.agent.codex');
        const icon = screen.findByTestId('session-cockpit-tab-chat-agent-icon');
        expect(icon?.props.agentId).toBe('codex');
    });

    it('does not render a session cockpit active pill overlay', async () => {
        const { SessionCockpitTabBar } = await import('./SessionCockpitTabBar');

        const screen = await renderScreen(
            <SessionCockpitTabBar
                sessionId="sess_1"
                activeSurface="git"
                terminalTabAvailable={true}
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
                onSurfacePress={() => {}}
            />,
        );

        expect(screen.findByTestId('session-cockpit-tab-git')?.props.accessibilityRole).toBe('tab');
        expect(screen.findByTestId('session-cockpit-tab-git')?.props.accessibilityState).toEqual({ selected: true });
        expect(screen.findByTestId('session-cockpit-tab-browse')?.props.accessibilityState).toEqual({ selected: false });
    }, 120_000);
});
