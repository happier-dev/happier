import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

const runAfterInteractionsSpy = vi.hoisted(() => vi.fn(() => () => {}));
type MockRouteHydrationState =
    | Readonly<{ kind: 'available'; sessionId: string; serverId?: string }>
    | Readonly<{ kind: 'loading'; sessionId: string; serverId?: string; reason: 'cold' }>
    | Readonly<{ kind: 'retrying'; sessionId: string; serverId?: string; cause: 'network' }>;
const hydrateSessionForRouteSpy = vi.hoisted(
    () => vi.fn((sessionId: string, _tag: string, options?: { serverId?: string }): MockRouteHydrationState => ({
        kind: 'available',
        sessionId,
        serverId: options?.serverId,
    })),
);
let deviceType: 'phone' | 'tablet' | 'desktop' = 'desktop';
let mobileWorkspaceExperience: 'classic' | 'cockpit' = 'classic';
let lastMobileSurfaceBySessionId: Record<string, string> = {};
let terminalTabAvailableForSessionId: string | null = null;
let sessionsById: Record<string, unknown> = {};
const storageListeners = new Set<() => void>();
let endpointConnectivityStatus = 'idle';
let syncError: { message: string; kind: 'auth' | 'config' | 'network' | 'server' | 'unknown'; serverId?: string | null } | null = null;
const terminalAvailabilityCalls: Array<unknown> = [];
const routeParams = vi.hoisted(() => ({
    value: { id: 'session-1' } as Record<string, string | undefined>,
}));
const activeServerRuntimeState = vi.hoisted(() => ({
    snapshot: { generation: 1 },
    listener: null as null | (() => void),
}));
const platformState = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'web',
}));

vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformState.os;
                },
            },
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
                        sessions: sessionsById,
                        sessionListViewDataByServerId: {},
                        localSettings: {
                            sessionLastMobileSurfaceBySessionId: lastMobileSurfaceBySessionId,
                        },
                    }),
                })) as any,
                storage: ((selector: (state: Record<string, unknown>) => unknown) => React.useSyncExternalStore(
                    (listener) => {
                        storageListeners.add(listener);
                        return () => storageListeners.delete(listener);
                    },
                    () => selector({
                        sessions: sessionsById,
                        sessionListViewDataByServerId: {},
                    }),
                )) as any,
                useEndpointConnectivity: (() => ({
                    status: endpointConnectivityStatus,
                    reason: null,
                    attempt: 0,
                    nextRetryAt: null,
                    lastConnectedAt: null,
                    lastDisconnectedAt: null,
                    lastErrorMessage: null,
                })) as any,
                useSyncError: (() => syncError) as any,
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
    useSessionTerminalAvailability: (params?: { sessionId?: string | null }) => {
        terminalAvailabilityCalls.push(params);
        return {
            sidebarTabAvailable: terminalTabAvailableForSessionId == null || params?.sessionId === terminalTabAvailableForSessionId,
        };
    },
}));

vi.mock('@/components/sessions/shell/SessionInvalidLinkFallback', () => ({
    SessionInvalidLinkFallback: () => React.createElement('SessionInvalidLinkFallback'),
}));

vi.mock('@/components/ui/feedback/ActivitySpinner', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/ui/feedback/ActivitySpinner')>(),
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
        hydrateSessionForRouteSpy.mockImplementation((sessionId: string, _tag: string, options?: { serverId?: string }): MockRouteHydrationState => ({
            kind: 'available',
            sessionId,
            serverId: options?.serverId,
        }));
        deviceType = 'desktop';
        mobileWorkspaceExperience = 'classic';
        lastMobileSurfaceBySessionId = {};
        terminalTabAvailableForSessionId = null;
        sessionsById = {};
        storageListeners.clear();
        endpointConnectivityStatus = 'idle';
        syncError = null;
        terminalAvailabilityCalls.length = 0;
        routeParams.value = { id: 'session-1' };
        platformState.os = 'ios';
        activeServerRuntimeState.snapshot = { generation: 1 };
        activeServerRuntimeState.listener = null;
    });

    it('mounts the session view immediately on native instead of waiting for interaction deferral', async () => {
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));

        expect(runAfterInteractionsSpy).not.toHaveBeenCalled();
        expect(screen.findAllByType('SessionView')).toHaveLength(1);
        const sessionView = screen.findByType('SessionView' as never);
        expect(sessionView.props.routeAnchorOverride).toBe(true);
        const [hydratedSessionId, hydrateTag] = hydrateSessionForRouteSpy.mock.calls.at(-1) ?? [];
        expect(hydratedSessionId).toBe('session-1');
        expect(String(hydrateTag)).toContain('gen=1');
    });

    it('lets web session views derive route anchoring from the current pathname instead of forcing stale mounted routes visible', async () => {
        platformState.os = 'web';
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));

        const sessionView = screen.findByType('SessionView' as never);
        expect(sessionView.props.routeAnchorOverride).toBeUndefined();
    });

    it('shows a loading spinner while hydration is pending and the session is not cached', async () => {
        hydrateSessionForRouteSpy.mockReturnValue({ kind: 'loading', sessionId: 'session-1', reason: 'cold' });
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));

        expect(screen.findAllByType('ActivitySpinner')).toHaveLength(1);
        expect(screen.findAllByType('SessionView')).toHaveLength(0);
        expect(screen.findAllByType('SessionCockpitShell')).toHaveLength(0);
    });

    it('mounts the session shell when hydration is retrying so retry status and navigation remain available', async () => {
        hydrateSessionForRouteSpy.mockReturnValue({ kind: 'retrying', sessionId: 'session-1', cause: 'network' });
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));

        expect(screen.findAllByType('ActivitySpinner')).toHaveLength(0);
        const sessionView = screen.findByType('SessionView' as never);
        expect(sessionView.props.routeHydrationState).toEqual({
            kind: 'retrying',
            sessionId: 'session-1',
            cause: 'network',
        });
    });

    it('mounts the session view when an inactive session is hydrated into the store after the route starts loading', async () => {
        routeParams.value = { id: 'session-1', serverId: 'server-target' };
        hydrateSessionForRouteSpy.mockReturnValue({
            kind: 'loading',
            sessionId: 'session-1',
            serverId: 'server-target',
            reason: 'cold',
        });
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));
        expect(screen.findAllByType('ActivitySpinner')).toHaveLength(1);

        await act(async () => {
            sessionsById = {
                'session-1': {
                    id: 'session-1',
                    serverId: 'server-target',
                    active: false,
                    metadata: { path: '/repo', machineId: 'machine-1' },
                },
            };
            for (const listener of storageListeners) listener();
        });

        expect(screen.findAllByType('ActivitySpinner')).toHaveLength(0);
        expect(screen.findAllByType('SessionView')).toHaveLength(1);
    });

    it('keeps loading when a cached same-id session belongs to a different route server', async () => {
        routeParams.value = { id: 'session-1', serverId: 'server-target' };
        sessionsById = {
            'session-1': {
                id: 'session-1',
                serverId: 'server-stale',
            },
        };
        hydrateSessionForRouteSpy.mockReturnValue({
            kind: 'loading',
            sessionId: 'session-1',
            serverId: 'server-target',
            reason: 'cold',
        });
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));

        expect(screen.findAllByType('ActivitySpinner')).toHaveLength(1);
        expect(screen.findAllByType('SessionView')).toHaveLength(0);
        expect(screen.findAllByType('SessionCockpitShell')).toHaveLength(0);
    });

    it('shows a loading spinner before mounting the cockpit shell while hydration is pending', async () => {
        hydrateSessionForRouteSpy.mockReturnValue({ kind: 'loading', sessionId: 'session-1', reason: 'cold' });
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));

        expect(screen.findAllByType('ActivitySpinner')).toHaveLength(1);
        expect(screen.findAllByType('SessionView')).toHaveLength(0);
        expect(screen.findAllByType('SessionCockpitShell')).toHaveLength(0);
    });

    it('rehydrates when active server listener reports a new generation', async () => {
        const Route = await import('@/app/(app)/session/[id]');
        await renderScreen(React.createElement(Route.default));

        expect(activeServerRuntimeState.listener).not.toBeNull();

        await act(async () => {
            activeServerRuntimeState.snapshot = { generation: 2 };
            activeServerRuntimeState.listener?.();
        });

        const latestTag = hydrateSessionForRouteSpy.mock.calls.at(-1)?.[1] ?? '';
        expect(String(latestTag)).toContain('gen=2');
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

    it('prefers the route server-scoped mobile surface over a legacy bare session id entry', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        routeParams.value = { id: 'session-1', serverId: 'server-b' };
        lastMobileSurfaceBySessionId = {
            'session-1': 'git',
            'server-b:session-1': 'tabs',
        };
        const Route = await import('@/app/(app)/session/[id]');

        const screen = await renderScreen(React.createElement(Route.default));

        const cockpit = screen.findByType('SessionCockpitShell' as never);
        expect(cockpit.props.surface).toBe('tabs');
    });

    it('keeps the cockpit terminal surface when the viewed session server enables terminal', async () => {
        deviceType = 'phone';
        mobileWorkspaceExperience = 'cockpit';
        terminalTabAvailableForSessionId = 'session-1';
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
        terminalTabAvailableForSessionId = 'session-scoped';
        routeParams.value = { id: 'session-scoped' };
        const Route = await import('@/app/(app)/session/[id]');

        await renderScreen(React.createElement(Route.default));

        expect(terminalAvailabilityCalls.at(-1)).toEqual(expect.objectContaining({ sessionId: 'session-scoped' }));
    });
});
