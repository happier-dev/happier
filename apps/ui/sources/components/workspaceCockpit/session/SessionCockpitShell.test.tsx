import * as React from 'react';

import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { SessionCockpitSurfaceNavigationProvider } from './SessionCockpitSurfaceNavigation';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let localSettingsMock: Record<string, unknown> = {};
const safeAreaInsetsMock = vi.hoisted(() => ({
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        useLocalSetting: (key: string) => localSettingsMock[key],
        useLocalSettingMutable: (key: string) => [
            localSettingsMock[key],
            (value: unknown) => {
                localSettingsMock[key] = value;
            },
        ],
    });
});

vi.mock('@react-navigation/native', () => ({
    useIsFocused: () => true,
}));

vi.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => safeAreaInsetsMock,
}));

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: (props: Record<string, unknown> & { contentOverride?: React.ReactNode }) => React.createElement(
        'SessionView',
        props,
        props.contentOverride ?? null,
    ),
}));

vi.mock('@/components/sessions/panes/SessionDetailsPanel', () => ({
    SessionDetailsPanel: (props: Record<string, unknown>) => React.createElement('SessionDetailsPanel', props),
}));

vi.mock('@/components/sessions/panes/surfaces/SessionBrowseFilesSurface', () => ({
    SessionBrowseFilesSurface: (props: Record<string, unknown>) => React.createElement('SessionBrowseFilesSurface', props),
}));

vi.mock('@/components/sessions/panes/surfaces/SessionGitSurface', () => ({
    SessionGitSurface: (props: Record<string, unknown>) => React.createElement('SessionGitSurface', props),
}));

vi.mock('@/components/sessions/panes/surfaces/SessionTerminalSurface', () => ({
    SessionTerminalSurface: (props: Record<string, unknown>) => React.createElement('SessionTerminalSurface', props),
}));

function PaneScopeProbe(props: Readonly<{ scopeId: string }>) {
    const pane = useAppPaneScope(props.scopeId);

    return React.createElement('PaneScopeProbe', {
        scopeState: pane.scopeState,
    });
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map((entry) => flattenStyle(entry)));
    }
    if (style && typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('SessionCockpitSurfaceScreen', () => {
    beforeEach(() => {
        standardCleanup();
        localSettingsMock = {};
        safeAreaInsetsMock.top = 0;
        safeAreaInsetsMock.bottom = 0;
        safeAreaInsetsMock.left = 0;
        safeAreaInsetsMock.right = 0;
    });

    it('closes an already-open right pane when the chat surface becomes active', async () => {
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: true, activeTabId: 'terminal', tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceScreen
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="chat"
                    routeServerId="server-b"
                    terminalTabAvailable
                />
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        await act(async () => {
            await screen.update(
                <AppPaneProvider>
                    <SessionCockpitSurfaceScreen
                        sessionId="s_1"
                        scopeId="session:s_1"
                        surface="chat"
                        routeServerId="server-b"
                        terminalTabAvailable
                    />
                    <PaneScopeProbe scopeId="session:s_1" />
                </AppPaneProvider>,
            );
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(probe.props.scopeState?.right).toEqual(expect.objectContaining({
            isOpen: false,
            activeTabId: 'terminal',
        }));
        const sessionView = screen.tree.findByType('SessionView' as never);
        expect(sessionView.props.id).toBe('s_1');
        expect(sessionView.props.routeServerId).toBe('server-b');
        expect(sessionView.props.routeAnchorOverride).toBe(true);
        expect(sessionView.props.chatBottomSpacing).toBe('none');
    });

    it('closes the details presentation when returning to chat from an opened details surface', async () => {
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: true,
                        tabs: [
                            {
                                key: 'scmReview:working',
                                kind: 'scmReview',
                                title: 'Review',
                                isPinned: true,
                                isPreview: false,
                                resource: { kind: 'scmReview' },
                            },
                        ],
                        activeTabKey: 'scmReview:working',
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceScreen
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="chat"
                    terminalTabAvailable
                />
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        await act(async () => {
            await screen.update(
                <AppPaneProvider>
                    <SessionCockpitSurfaceScreen
                        sessionId="s_1"
                        scopeId="session:s_1"
                        surface="chat"
                        terminalTabAvailable
                    />
                    <PaneScopeProbe scopeId="session:s_1" />
                </AppPaneProvider>,
            );
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(probe.props.scopeState?.details).toEqual(expect.objectContaining({
            isOpen: false,
            activeTabKey: 'scmReview:working',
        }));
        expect(probe.props.scopeState?.details?.tabs).toHaveLength(1);
    });

    it('renders a stable terminal screen wrapper when the terminal surface is active', async () => {
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceScreen
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="terminal"
                    routeServerId="server-b"
                    terminalTabAvailable
                />
            </AppPaneProvider>,
        );

        const sessionView = screen.tree.findByType('SessionView' as never);
        expect(sessionView.props.id).toBe('s_1');
        expect(sessionView.props.routeServerId).toBe('server-b');
        expect(sessionView.props.contentOverride).toBeTruthy();
        expect(screen.tree.findByProps({ testID: 'session-terminal-screen' } as never)).toBeTruthy();
        expect(screen.tree.findByType('SessionTerminalSurface' as never).props.sessionId).toBe('s_1');
    });

    it('delegates route-owned safe-area padding to the shared session chrome', async () => {
        safeAreaInsetsMock.top = 24;
        safeAreaInsetsMock.bottom = 12;
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceScreen
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="terminal"
                    safeAreaPadding={false}
                    terminalTabAvailable
                />
            </AppPaneProvider>,
        );

        const sessionView = screen.tree.findByType('SessionView' as never);
        expect(sessionView.props.safeAreaTopMode).toBe('internal');
        expect(sessionView.props.headerSafeAreaTopMode).toBe('internal');

        const terminalScreen = screen.tree.findByProps({ testID: 'session-terminal-screen' } as never);
        expect(flattenStyle(terminalScreen.props.style)).toMatchObject({
            paddingTop: 0,
            paddingBottom: 0,
        });
    });

    it('uses screen presentation for fallback details when the route owns safe-area padding', async () => {
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceScreen
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="tabs"
                    safeAreaPadding={false}
                    terminalTabAvailable
                />
            </AppPaneProvider>,
        );

        const detailsPanel = screen.tree.findByType('SessionDetailsPanel' as never);
        expect(detailsPanel.props.presentation).toBe('screen');
        expect(detailsPanel.props.showHeaderActions).toBe(false);
    });

    it('opens file details on the internal details tab without pushing a sibling stack route', async () => {
        const switchSurface = vi.fn();
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceNavigationProvider value={{ switchSurface }}>
                    <SessionCockpitSurfaceScreen
                        sessionId="s_1"
                        scopeId="session:s_1"
                        surface="browse"
                        routeServerId="server-b"
                        terminalTabAvailable
                    />
                </SessionCockpitSurfaceNavigationProvider>
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        const browseSurface = screen.tree.findByType('SessionBrowseFilesSurface' as never);

        await act(async () => {
            browseSurface.props.onOpenFile('src/example.ts');
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(switchSurface).toHaveBeenCalledWith('tabs');
        expect(probe.props.scopeState?.details?.isOpen).toBe(true);
        expect(probe.props.scopeState?.details?.tabs).toEqual([
            expect.objectContaining({
                key: 'file:src/example.ts',
                resource: { kind: 'file', path: 'src/example.ts' },
            }),
        ]);
    });

    it('opens commit details on the internal details tab without pushing a sibling stack route', async () => {
        const switchSurface = vi.fn();
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceNavigationProvider value={{ switchSurface }}>
                    <SessionCockpitSurfaceScreen
                        sessionId="s_1"
                        scopeId="session:s_1"
                        surface="git"
                        routeServerId="server-b"
                        terminalTabAvailable
                    />
                </SessionCockpitSurfaceNavigationProvider>
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        const gitSurface = screen.tree.findByType('SessionGitSurface' as never);

        await act(async () => {
            gitSurface.props.onOpenCommit('abc1234 extra');
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(switchSurface).toHaveBeenCalledWith('tabs');
        expect(probe.props.scopeState?.details?.tabs).toEqual([
            expect.objectContaining({
                key: 'commit:abc1234',
                resource: { kind: 'commit', sha: 'abc1234' },
            }),
        ]);
    });

    it('opens review details on the internal details tab without pushing a sibling stack route', async () => {
        const switchSurface = vi.fn();
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceNavigationProvider value={{ switchSurface }}>
                    <SessionCockpitSurfaceScreen
                        sessionId="s_1"
                        scopeId="session:s_1"
                        surface="git"
                        routeServerId="server-b"
                        terminalTabAvailable
                    />
                </SessionCockpitSurfaceNavigationProvider>
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        const gitSurface = screen.tree.findByType('SessionGitSurface' as never);

        await act(async () => {
            gitSurface.props.onOpenReviewAllChanges();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(switchSurface).toHaveBeenCalledWith('tabs');
        expect(probe.props.scopeState?.details?.tabs).toEqual([
            expect.objectContaining({
                key: 'scmReview:working',
                resource: { kind: 'scmReview', scope: 'working' },
            }),
        ]);
    });

    it('opens stash details on the internal details tab without pushing a sibling stack route', async () => {
        const switchSurface = vi.fn();
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceNavigationProvider value={{ switchSurface }}>
                    <SessionCockpitSurfaceScreen
                        sessionId="s_1"
                        scopeId="session:s_1"
                        surface="git"
                        routeServerId="server-b"
                        terminalTabAvailable
                    />
                </SessionCockpitSurfaceNavigationProvider>
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        const gitSurface = screen.tree.findByType('SessionGitSurface' as never);

        await act(async () => {
            gitSurface.props.onOpenStashDetails();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(switchSurface).toHaveBeenCalledWith('tabs');
        expect(probe.props.scopeState?.details?.tabs).toEqual([
            expect.objectContaining({
                key: 'scmStash',
                resource: { kind: 'scmStash' },
            }),
        ]);
    });

    it('opens a new terminal details tab on the internal details surface', async () => {
        const switchSurface = vi.fn();
        localSettingsMock = {
            appPaneScopesV1: {
                'session:s_1': {
                    right: { isOpen: false, activeTabId: null, tabState: {} },
                    details: {
                        isOpen: false,
                        tabs: [],
                        activeTabKey: null,
                        tabState: {},
                    },
                    bottom: { isOpen: false, activeTabId: null, tabState: {} },
                },
            },
            sessionLastMobileSurfaceBySessionId: null,
        };

        const { SessionCockpitSurfaceScreen } = await import('./SessionCockpitSurfaceScreen');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitSurfaceNavigationProvider value={{ switchSurface }}>
                    <SessionCockpitSurfaceScreen
                        sessionId="s_1"
                        scopeId="session:s_1"
                        surface="terminal"
                        routeServerId="server-b"
                        terminalTabAvailable
                    />
                </SessionCockpitSurfaceNavigationProvider>
                <PaneScopeProbe scopeId="session:s_1" />
            </AppPaneProvider>,
        );

        const terminalSurface = screen.tree.findByType('SessionTerminalSurface' as never);

        await act(async () => {
            terminalSurface.props.onOpenNewTerminalTab();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const probe = screen.tree.findByType('PaneScopeProbe' as never);
        expect(switchSurface).toHaveBeenCalledWith('tabs');
        expect(probe.props.scopeState?.details?.tabs).toEqual([
            expect.objectContaining({
                kind: 'terminal',
                resource: expect.objectContaining({ kind: 'terminal' }),
            }),
        ]);
    });
});
