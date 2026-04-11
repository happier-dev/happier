import * as React from 'react';

import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAppPaneScope } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let localSettingsMock: Record<string, unknown> = {};
const routerPushSpy = vi.fn();

const expoRouterMock = createExpoRouterMock({
    router: {
        push: routerPushSpy,
    },
});

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

vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: (props: Record<string, unknown>) => React.createElement('SessionView', props),
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

describe('SessionCockpitShell', () => {
    beforeEach(() => {
        standardCleanup();
        localSettingsMock = {};
        routerPushSpy.mockClear();
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

        const { SessionCockpitShell } = await import('./SessionCockpitShell');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitShell
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
                    <SessionCockpitShell
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
        expect(probe.props.scopeState?.right).toEqual(expect.objectContaining({
            isOpen: false,
            activeTabId: 'terminal',
        }));
        expect(screen.tree.findByType('SessionView' as never).props.id).toBe('s_1');
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

        const { SessionCockpitShell } = await import('./SessionCockpitShell');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitShell
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="terminal"
                    terminalTabAvailable
                />
            </AppPaneProvider>,
        );

        expect(screen.tree.findByProps({ testID: 'session-terminal-screen' } as never)).toBeTruthy();
        expect(screen.tree.findByType('SessionTerminalSurface' as never).props.sessionId).toBe('s_1');
    });

    it('navigates to the details route when a browse surface file opens in cockpit mode', async () => {
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

        const { SessionCockpitShell } = await import('./SessionCockpitShell');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitShell
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="browse"
                    terminalTabAvailable
                />
            </AppPaneProvider>,
        );

        const browseSurface = screen.tree.findByType('SessionBrowseFilesSurface' as never);

        await act(async () => {
            browseSurface.props.onOpenFile('src/example.ts');
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/session/[id]/details',
            params: {
                id: 's_1',
                details: 'file',
                path: 'src/example.ts',
            },
        });
    });

    it('navigates to the details route when a git surface commit opens in cockpit mode', async () => {
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

        const { SessionCockpitShell } = await import('./SessionCockpitShell');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitShell
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="git"
                    terminalTabAvailable
                />
            </AppPaneProvider>,
        );

        const gitSurface = screen.tree.findByType('SessionGitSurface' as never);

        await act(async () => {
            gitSurface.props.onOpenCommit('abc1234 extra');
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/session/[id]/details',
            params: {
                id: 's_1',
                details: 'commit',
                sha: 'abc1234',
            },
        });
    });

    it('navigates to the details route when a terminal surface opens a new details tab in cockpit mode', async () => {
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

        const { SessionCockpitShell } = await import('./SessionCockpitShell');
        const screen = await renderScreen(
            <AppPaneProvider>
                <SessionCockpitShell
                    sessionId="s_1"
                    scopeId="session:s_1"
                    surface="terminal"
                    terminalTabAvailable
                />
            </AppPaneProvider>,
        );

        const terminalSurface = screen.tree.findByType('SessionTerminalSurface' as never);

        await act(async () => {
            terminalSurface.props.onOpenNewTerminalTab();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(routerPushSpy).toHaveBeenCalledWith({
            pathname: '/session/[id]/details',
            params: expect.objectContaining({
                id: 's_1',
                details: 'terminal',
                terminalInstanceId: expect.any(String),
            }),
        });
    });
});
