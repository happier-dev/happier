import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';
import type { SessionRouteHydrationState } from '@/sync/domains/session/sessionRouteHydrationState';

const runAfterInteractionsSpy = vi.hoisted(() => vi.fn(() => () => {}));
const hydrateSessionForRouteSpy = vi.hoisted(
    () => vi.fn((sessionId: string, _tag: string, options?: { serverId?: string }): SessionRouteHydrationState => ({
        kind: 'available' as const,
        sessionId,
        serverId: options?.serverId,
    })),
);
let deviceType: 'phone' | 'tablet' | 'desktop' = 'desktop';
let mobileWorkspaceExperience: 'classic' | 'cockpit' = 'classic';
let lastMobileSurfaceBySessionId: Record<string, string> = {};
let terminalTabAvailable = false;
let sessionsById: Record<string, unknown> = {};
const storageListeners = new Set<() => void>();
const terminalAvailabilityCalls: Array<unknown> = [];
const routeParams = vi.hoisted(() => ({
    value: { id: 'session-1' } as Record<string, string | undefined>,
}));
const activeServerRuntimeState = vi.hoisted(() => ({
    snapshot: { generation: 1 },
    listener: null as null | (() => void),
}));

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: { OS: 'ios' },
            View: 'View',
            ActivityIndicator: 'ActivityIndicator',
        });
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const routerMock = createExpoRouterMock();
        return {
            ...routerMock.module,
            useLocalSearchParams: () => routeParams.value,
            useGlobalSearchParams: () => routeParams.value,
        };
    },
    storageModule: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: ((key: string) => {
                    if (key === 'mobileWorkspaceExperienceV1') return mobileWorkspaceExperience;
                    return null;
                }) as any,
                useSettingMutable: ((key: string) => [
                    key === 'mobileWorkspaceExperienceV1' ? mobileWorkspaceExperience : null,
                    vi.fn(),
                ]) as any,
                useLocalSetting: ((key: string) => {
                    if (key === 'sessionLastMobileSurfaceBySessionId') return lastMobileSurfaceBySessionId;
                    return null;
                }) as any,
                getStorage: (() => ({
                    getState: () => ({
                        localSettings: {
                            sessionLastMobileSurfaceBySessionId: lastMobileSurfaceBySessionId,
                        },
                    }),
                })) as any,
            },
        });
    },
});

vi.mock('@/components/sessions/shell/SessionView', () => ({
    SessionView: (props: any) => React.createElement('SessionView', props),
}));

vi.mock('@/components/workspaceCockpit/session/SessionCockpitShell', () => ({
    SessionCockpitShell: (props: any) => React.createElement('SessionCockpitShell', props),
}));

vi.mock('@/components/appShell/panes/hooks/useAppPaneScope', () => ({
    useAppPaneScope: () => ({
        scopeState: {
            right: { activeTabId: null },
            details: { tabs: [] },
        },
    }),
}));

vi.mock('@/components/sessions/terminal/useSessionTerminalAvailability', () => ({
    useSessionTerminalAvailability: (...args: unknown[]) => {
        terminalAvailabilityCalls.push(args[0]);
        return {
            sidebarTabAvailable: terminalTabAvailable,
        };
    },
}));

vi.mock('@/sync/domains/state/storageStore', () => {
    const buildState = () => ({
        sessions: sessionsById,
        sessionListIndexByServerId: {},
        concurrentSessionListCacheByServerId: {},
        getProjectForSession: () => null,
        localSettings: {
            sessionLastMobileSurfaceBySessionId: lastMobileSurfaceBySessionId,
        },
    });
    const storage = Object.assign(
        (selector?: (state: Record<string, unknown>) => unknown) => React.useSyncExternalStore(
            (listener) => {
                storageListeners.add(listener);
                return () => storageListeners.delete(listener);
            },
            () => typeof selector === 'function' ? selector(buildState()) : buildState(),
            () => typeof selector === 'function' ? selector(buildState()) : buildState(),
        ),
        {
            getState: () => buildState(),
            subscribe: (listener: () => void) => {
                storageListeners.add(listener);
                return () => storageListeners.delete(listener);
            },
        },
    );
    return {
        storage,
        getStorage: () => storage,
    };
});

vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({
        refreshFromActiveServer: vi.fn(async () => {}),
    }),
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback'),
}));

vi.mock('@/components/ui/feedback/ActivitySpinner', () => ({
    ActivitySpinner: (props: Record<string, unknown>) => React.createElement('ActivitySpinner', props),
}));

vi.mock('@/hooks/session/useHydrateSessionForRoute', () => ({
    useHydrateSessionForRoute: (sessionId: string, tag: string, options?: { serverId?: string }) =>
        hydrateSessionForRouteSpy(sessionId, tag, options),
}));

vi.mock('@/utils/timing/runAfterInteractionsWithFallback', () => ({
    runAfterInteractionsWithFallback: runAfterInteractionsSpy,
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    getTempData: () => null,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => activeServerRuntimeState.snapshot,
    subscribeActiveServer: (listener: () => void) => {
        activeServerRuntimeState.listener = listener;
        return () => {
            if (activeServerRuntimeState.listener === listener) {
                activeServerRuntimeState.listener = null;
            }
        };
    },
}));

vi.mock('@/components/sessions/panes/url/sessionPaneUrlState', () => ({
    parseSessionPaneUrlState: () => null,
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => deviceType,
}));

describe('session route index', () => {
    afterEach(() => {
        standardCleanup();
        runAfterInteractionsSpy.mockClear();
        hydrateSessionForRouteSpy.mockReset();
        hydrateSessionForRouteSpy.mockImplementation((sessionId: string, _tag: string, options?: { serverId?: string }) => ({
            kind: 'available' as const,
            sessionId,
            serverId: options?.serverId,
        }));
        deviceType = 'desktop';
        mobileWorkspaceExperience = 'classic';
        lastMobileSurfaceBySessionId = {};
        terminalTabAvailable = false;
        sessionsById = {};
        storageListeners.clear();
        terminalAvailabilityCalls.length = 0;
        routeParams.value = { id: 'session-1' };
        activeServerRuntimeState.snapshot = { generation: 1 };
        activeServerRuntimeState.listener = null;
    });

    it('mounts the session view immediately on native instead of waiting for interaction deferral', async () => {
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));

        expect(runAfterInteractionsSpy).not.toHaveBeenCalled();
        expect(screen.findAllByType('SessionView')).toHaveLength(1);
        const [hydratedSessionId, hydrateTag] = hydrateSessionForRouteSpy.mock.calls.at(-1) ?? [];
        expect(hydratedSessionId).toBe('session-1');
        expect(String(hydrateTag)).toBe('SessionCanvasLeaf.ensureSessionVisible');
    });

    it('shows a loading spinner while hydration is pending and the session is not cached', async () => {
        hydrateSessionForRouteSpy.mockImplementation((sessionId: string) => ({
            kind: 'loading' as const,
            sessionId,
            reason: 'store-miss' as const,
        }));
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));

        expect(screen.findAllByType('ActivitySpinner')).toHaveLength(1);
        expect(screen.findAllByType('SessionView')).toHaveLength(0);
        expect(screen.findAllByType('SessionCockpitShell')).toHaveLength(0);
    });

    it('mounts the session view reactively when the scoped session lands after route hydration started', async () => {
        routeParams.value = { id: 'session-1', serverId: 'server-a' };
        hydrateSessionForRouteSpy.mockImplementation((sessionId: string) => ({
            kind: 'loading' as const,
            sessionId,
            reason: 'store-miss' as const,
        }));
        const Route = await import('@/app/(app)/session/[id]');
        const screen = await renderScreen(React.createElement(Route.default));

        expect(screen.findAllByType('ActivitySpinner')).toHaveLength(1);

        await act(async () => {
            sessionsById = {
                'session-1': { id: 'session-1', serverId: 'server-a', active: false, seq: 0 },
            };
            for (const listener of storageListeners) listener();
        });

        expect(screen.findAllByType('ActivitySpinner')).toHaveLength(0);
        expect(screen.findAllByType('SessionView')).toHaveLength(1);
    });

    it('shows a loading spinner before mounting the cockpit shell while hydration is pending', async () => {
        hydrateSessionForRouteSpy.mockImplementation((sessionId: string) => ({
            kind: 'loading' as const,
            sessionId,
            reason: 'store-miss' as const,
        }));
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));

        expect(screen.findAllByType('ActivitySpinner')).toHaveLength(1);
        expect(screen.findAllByType('SessionView')).toHaveLength(0);
        expect(screen.findAllByType('SessionCockpitShell')).toHaveLength(0);
    });

    it('prefers the route server-scoped persisted mobile surface over the legacy bare session id entry', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        routeParams.value = { id: 'session-1', serverId: 'server-b' };
        lastMobileSurfaceBySessionId = {
            'session-1': 'git',
            'server-b:session-1': 'tabs',
        };
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));
        const shells = screen.findAllByType('SessionCockpitShell');

        expect(shells).toHaveLength(1);
        expect(shells[0]?.props.surface).toBe('tabs');
    });

    it('rehydrates when active server listener reports a new generation', async () => {
        const Route = await import('@/app/(app)/session/[id]');
        await renderScreen(React.createElement(Route.default));

        expect(activeServerRuntimeState.listener).not.toBeNull();

        await act(async () => {
            activeServerRuntimeState.snapshot = { generation: 2 };
            activeServerRuntimeState.listener?.();
        });

        expect(hydrateSessionForRouteSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
        const latestTag = hydrateSessionForRouteSpy.mock.calls.at(-1)?.[1] ?? '';
        expect(String(latestTag)).toBe('SessionCanvasLeaf.ensureSessionVisible');
    });

    it('renders the session cockpit shell on phone when cockpit mode is enabled by default', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        routeParams.value = { id: 'session-1', serverId: 'server-b' };
        lastMobileSurfaceBySessionId = { 'session-1': 'git' };
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));

        const cockpit = screen.findByType('SessionCockpitShell' as never);
        expect(cockpit.props.sessionId).toBe('session-1');
        expect(cockpit.props.scopeId).toBe('session:session-1');
        expect(cockpit.props.surface).toBe('git');
        expect(cockpit.props.routeServerId).toBe('server-b');
        expect(screen.findAllByType('SessionView')).toHaveLength(0);
    });

    it('keeps the cockpit terminal surface when the viewed session server enables terminal', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        terminalTabAvailable = true;
        routeParams.value = { id: 'session-1', serverId: 'server-b', mobileSurface: 'terminal' };
        lastMobileSurfaceBySessionId = { 'session-1': 'terminal' };
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));

        const cockpit = screen.findByType('SessionCockpitShell' as never);
        expect(cockpit.props.surface).toBe('terminal');
    });

    it('scopes terminal availability to the viewed session id in cockpit mode', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        terminalTabAvailable = true;
        routeParams.value = { id: 'session-scoped' };
        const Route = await import('@/app/(app)/session/[id]');

        await renderScreen(React.createElement(Route.default));

        expect(terminalAvailabilityCalls.length).toBeGreaterThan(0);
        expect(terminalAvailabilityCalls.at(-1)).toBeUndefined();
    });
});
