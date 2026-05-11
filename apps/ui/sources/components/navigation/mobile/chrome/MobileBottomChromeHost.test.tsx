import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleStub } from '@/dev/testkit/mocks/storage';
import {
    clearPendingMobileSurfaceTransition,
    resolvePendingMobileSurfaceTransitionStackOptions,
} from '@/components/navigation/mobile/transition/mobileSurfaceTransitionIntent';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const pathState = vi.hoisted(() => ({
    pathname: '/',
}));
const searchParamsState = vi.hoisted(() => ({
    mobileSurface: undefined as string | string[] | undefined,
    worktreeId: undefined as string | string[] | undefined,
    serverId: undefined as string | string[] | undefined,
    sourceSurface: undefined as string | string[] | undefined,
}));

const authState = vi.hoisted(() => ({
    isAuthenticated: true,
}));

const tabState = vi.hoisted(() => ({
    activeTab: 'sessions' as const,
    setActiveTab: vi.fn(async () => {}),
}));

const settingsState = vi.hoisted(() => ({
    mobileWorkspaceExperienceV1: 'classic' as 'classic' | 'cockpit',
    sessionLastMobileSurfaceBySessionId: null as Record<string, string> | null,
    projectLastMobileSurfaceByWorkspaceRefId: null as Record<string, string> | null,
    embeddedTerminalDockLocation: 'sidebar' as string | null,
}));
const storageListeners = vi.hoisted(() => ({
    listeners: new Set<() => void>(),
}));
const deviceTypeState = vi.hoisted(() => ({
    value: 'phone' as 'phone' | 'tablet' | 'desktop',
}));
const featureState = vi.hoisted(() => ({
    terminalEmbeddedPtyEnabled: true,
}));
const storageMutators = vi.hoisted(() => ({
    setSessionLastMobileSurfaceBySessionId: vi.fn(),
    setProjectLastMobileSurfaceByWorkspaceRefId: vi.fn(),
}));
const routerState = vi.hoisted(() => ({
    back: vi.fn(),
    replace: vi.fn(),
}));

const expoRouterMock = createExpoRouterMock({
    pathname: () => pathState.pathname,
    params: () => ({
        mobileSurface: searchParamsState.mobileSurface,
        worktreeId: searchParamsState.worktreeId,
        serverId: searchParamsState.serverId,
        sourceSurface: searchParamsState.sourceSurface,
    }),
    router: {
        back: () => routerState.back(),
        replace: (value: unknown) => routerState.replace(value),
    },
});

vi.mock('expo-router', () => expoRouterMock.module);

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => authState,
}));

vi.mock('./MainAppTabStateProvider', () => ({
    useMainAppTabState: () => tabState,
}));

const storageMock = createStorageModuleStub({
    useSetting: (key: string) => React.useSyncExternalStore(
        (listener) => {
            storageListeners.listeners.add(listener);
            return () => {
                storageListeners.listeners.delete(listener);
            };
        },
        () => readSettingValue(key),
        () => readSettingValue(key),
    ),
    useLocalSetting: (key: string) => React.useSyncExternalStore(
        (listener) => {
            storageListeners.listeners.add(listener);
            return () => {
                storageListeners.listeners.delete(listener);
            };
        },
        () => readLocalSettingValue(key),
        () => readLocalSettingValue(key),
    ),
    useLocalSettingMutable: (key: string) => {
        if (key === 'sessionLastMobileSurfaceBySessionId') {
            return [
                settingsState.sessionLastMobileSurfaceBySessionId,
                (value: Record<string, string> | null) => {
                    settingsState.sessionLastMobileSurfaceBySessionId = value;
                    storageMutators.setSessionLastMobileSurfaceBySessionId(value);
                    notifyStorageListeners();
                },
            ];
        }
        if (key === 'projectLastMobileSurfaceByWorkspaceRefId') {
            return [
                settingsState.projectLastMobileSurfaceByWorkspaceRefId,
                (value: Record<string, string> | null) => {
                    settingsState.projectLastMobileSurfaceByWorkspaceRefId = value;
                    storageMutators.setProjectLastMobileSurfaceByWorkspaceRefId(value);
                    notifyStorageListeners();
                },
            ];
        }
        return [null, vi.fn()];
    },
});

vi.mock('@/sync/domains/state/storage', () => storageMock);

function readSettingValue(key: string): unknown {
    if (key === 'mobileWorkspaceExperienceV1') {
        return settingsState.mobileWorkspaceExperienceV1;
    }
    return null;
}

function readLocalSettingValue(key: string): unknown {
    if (key === 'mobileWorkspaceExperienceV1') {
        throw new Error('mobileWorkspaceExperienceV1 must use synced account settings');
    }
    if (key === 'sessionLastMobileSurfaceBySessionId') {
        return settingsState.sessionLastMobileSurfaceBySessionId;
    }
    if (key === 'projectLastMobileSurfaceByWorkspaceRefId') {
        return settingsState.projectLastMobileSurfaceByWorkspaceRefId;
    }
    if (key === 'embeddedTerminalDockLocation') {
        return settingsState.embeddedTerminalDockLocation;
    }
    return null;
}

function notifyStorageListeners(): void {
    for (const listener of storageListeners.listeners) {
        listener();
    }
}

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceTypeState.value,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => {
        if (featureId === 'terminal.embeddedPty') {
            return featureState.terminalEmbeddedPtyEnabled;
        }
        return false;
    },
}));

vi.mock('./bars/MainAppTabBar', () => ({
    MainAppTabBar: (props: Record<string, unknown>) => React.createElement('MainAppTabBar', props),
}));

vi.mock('./bars/SessionCockpitTabBar', () => ({
    SessionCockpitTabBar: (props: Record<string, unknown>) => React.createElement('SessionCockpitTabBar', props),
}));

vi.mock('./bars/ProjectCockpitTabBar', () => ({
    ProjectCockpitTabBar: (props: Record<string, unknown>) => React.createElement('ProjectCockpitTabBar', props),
}));

describe('MobileBottomChromeHost', () => {
    afterEach(() => {
        routerState.replace.mockReset();
        routerState.back.mockReset();
        storageMutators.setSessionLastMobileSurfaceBySessionId.mockReset();
        storageMutators.setProjectLastMobileSurfaceByWorkspaceRefId.mockReset();
        storageListeners.listeners.clear();
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;
        searchParamsState.serverId = undefined;
        searchParamsState.sourceSurface = undefined;
        clearPendingMobileSurfaceTransition();
    });

    it('renders the main app tab bar on the authenticated home route', async () => {
        pathState.pathname = '/';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('MainAppTabBar' as never);
        expect(bar.props.activeTab).toBe('sessions');
    });

    it('ignores a press on the already selected main app tab', async () => {
        pathState.pathname = '/';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        deviceTypeState.value = 'phone';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('MainAppTabBar' as never);
        act(() => {
            void bar.props.onTabPress('sessions');
        });

        expect(tabState.setActiveTab).not.toHaveBeenCalled();
        expect(routerState.replace).not.toHaveBeenCalled();
    });

    it('does not render the main app tab bar on desktop even on the authenticated home route', async () => {
        pathState.pathname = '/';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'desktop';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('MainAppTabBar' as never)).toHaveLength(0);
    });

    it('renders the session cockpit bar on cockpit-enabled session routes', async () => {
        pathState.pathname = '/session/session-1/files';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(bar.props.sessionId).toBe('session-1');
        expect(bar.props.activeSurface).toBe('browse');
        expect(bar.props.terminalTabAvailable).toBe(true);
    });

    it('does not render session cockpit chrome for session history routes', async () => {
        pathState.pathname = '/session/archived';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('ProjectCockpitTabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('MainAppTabBar' as never)).toHaveLength(0);
    });

    it('renders the project cockpit bar on cockpit-enabled project routes', async () => {
        pathState.pathname = '/projects/wr_1/git';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('ProjectCockpitTabBar' as never);
        expect(bar.props.workspaceRefId).toBe('wr_1');
        expect(bar.props.activeSurface).toBe('git');
    });

    it('hides bottom chrome on non-home routes', async () => {
        pathState.pathname = '/session/s_123';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'classic';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('MainAppTabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
        expect(screen.tree.findAllByType('ProjectCockpitTabBar' as never)).toHaveLength(0);
    });

    it('passes terminal availability through to the session cockpit bar', async () => {
        pathState.pathname = '/session/session-1';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'bottom';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = false;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(bar.props.terminalTabAvailable).toBe(false);
    });

    it('persists the selected session cockpit surface before navigating', async () => {
        pathState.pathname = '/session/session-1';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = { 'session-1': 'terminal' };
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        await act(async () => {
            bar.props.onSurfacePress('chat');
        });

        expect(storageMutators.setSessionLastMobileSurfaceBySessionId).toHaveBeenCalledWith({
            'session-1': 'chat',
        });
        expect(routerState.replace).toHaveBeenCalledWith('/session/session-1?mobileSurface=chat');
    });

    it('shows the target main app chrome immediately when returning from a session cockpit route', async () => {
        pathState.pathname = '/session/session-1/files';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(1);

        pathState.pathname = '/';
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = {};
        await act(async () => {
            notifyStorageListeners();
        });

        expect(screen.tree.findAllByType('SessionCockpitTabBar' as never)).toHaveLength(0);
        const bar = screen.tree.findByType('MainAppTabBar' as never);
        expect(bar.props.activeTab).toBe('sessions');
    });

    it('preserves the scoped server id when navigating between session cockpit tabs', async () => {
        pathState.pathname = '/session/session-1/files';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;
        searchParamsState.serverId = 'server-b';

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        await act(async () => {
            bar.props.onSurfacePress('git');
        });

        expect(routerState.replace).toHaveBeenCalledWith('/session/session-1/git?serverId=server-b');
        expect(resolvePendingMobileSurfaceTransitionStackOptions({
            routeName: 'session/[id]/git',
        })).toEqual({
            animation: 'slide_from_right',
            animationTypeForReplace: 'push',
        });
    });

    it('waits for the sourced details route to collapse before replacing its source surface', async () => {
        vi.useFakeTimers();
        try {
            pathState.pathname = '/session/session-1/details';
            authState.isAuthenticated = true;
            settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
            settingsState.sessionLastMobileSurfaceBySessionId = null;
            settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
            settingsState.embeddedTerminalDockLocation = 'sidebar';
            deviceTypeState.value = 'phone';
            featureState.terminalEmbeddedPtyEnabled = true;
            searchParamsState.mobileSurface = undefined;
            searchParamsState.worktreeId = undefined;
            searchParamsState.serverId = 'server-b';
            searchParamsState.sourceSurface = 'browse';

            const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
            const screen = await renderScreen(<MobileBottomChromeHost />);

            const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
            await act(async () => {
                bar.props.onSurfacePress('git');
            });

            expect(storageMutators.setSessionLastMobileSurfaceBySessionId).toHaveBeenCalledWith({
                'session-1': 'git',
            });
            expect(resolvePendingMobileSurfaceTransitionStackOptions({
                routeName: 'session/[id]/git',
            })).toEqual({
                animation: 'slide_from_left',
                animationTypeForReplace: 'pop',
            });
            expect(routerState.back).toHaveBeenCalledTimes(1);
            expect(routerState.replace).not.toHaveBeenCalled();

            await act(async () => {
                vi.runOnlyPendingTimers();
            });
            expect(routerState.replace).not.toHaveBeenCalled();

            pathState.pathname = '/session/session-1/files';
            searchParamsState.sourceSurface = undefined;
            await act(async () => {
                settingsState.projectLastMobileSurfaceByWorkspaceRefId = {};
                notifyStorageListeners();
            });

            expect(routerState.replace).toHaveBeenCalledWith('/session/session-1/git?serverId=server-b');
        } finally {
            vi.useRealTimers();
        }
    });

    it('routes root session surface changes through an explicit mobile-surface hint', async () => {
        pathState.pathname = '/session/session-1/terminal';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = { 'session-1': 'terminal' };
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        await act(async () => {
            bar.props.onSurfacePress('chat');
        });

        expect(routerState.replace).toHaveBeenCalledWith('/session/session-1?mobileSurface=chat');
    });

    it('keeps the selected root session surface active when the route remounts with the mobile-surface hint', async () => {
        pathState.pathname = '/session/session-1';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = { 'session-1': 'terminal' };
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = null;
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = 'chat';
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('SessionCockpitTabBar' as never);
        expect(bar.props.activeSurface).toBe('chat');
    });

    it('routes root project surface changes through an explicit mobile-surface hint', async () => {
        pathState.pathname = '/projects/wr_1/terminal';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = { wr_1: 'terminal' };
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('ProjectCockpitTabBar' as never);
        await act(async () => {
            bar.props.onSurfacePress('overview');
        });

        expect(routerState.replace).toHaveBeenCalledWith('/projects/wr_1?mobileSurface=overview');
    });

    it('keeps the selected root project surface active when the route remounts with the mobile-surface hint', async () => {
        pathState.pathname = '/projects/wr_1';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = { wr_1: 'terminal' };
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = 'overview';
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        const bar = screen.tree.findByType('ProjectCockpitTabBar' as never);
        expect(bar.props.activeSurface).toBe('overview');
    });

    it('hides project cockpit chrome after the mobile workspace experience switches back to classic', async () => {
        pathState.pathname = '/projects/wr_1/files';
        authState.isAuthenticated = true;
        settingsState.mobileWorkspaceExperienceV1 = 'cockpit';
        settingsState.sessionLastMobileSurfaceBySessionId = null;
        settingsState.projectLastMobileSurfaceByWorkspaceRefId = { wr_1: 'browse' };
        settingsState.embeddedTerminalDockLocation = 'sidebar';
        deviceTypeState.value = 'phone';
        featureState.terminalEmbeddedPtyEnabled = true;
        searchParamsState.mobileSurface = undefined;
        searchParamsState.worktreeId = undefined;

        const { MobileBottomChromeHost } = await import('./MobileBottomChromeHost');
        const screen = await renderScreen(<MobileBottomChromeHost />);

        expect(screen.tree.findAllByType('ProjectCockpitTabBar' as never)).toHaveLength(1);

        await act(async () => {
            settingsState.mobileWorkspaceExperienceV1 = 'classic';
            notifyStorageListeners();
        });

        expect(screen.tree.findAllByType('ProjectCockpitTabBar' as never)).toHaveLength(0);
    });
});
