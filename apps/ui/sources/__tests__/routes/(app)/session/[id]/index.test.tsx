import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { selectActiveTestHomeForTests } from '@/dev/testkit/fixtures/persistedHomeProfiles';
import { act } from 'react-test-renderer';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import type { Deferred } from '@/dev/testkit';
import { installSessionRouteCommonModuleMocks } from './sessionRouteTestHelpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let phone = false;
let holdInteractionJobs = false;
const heldInteractionJobs = new Set<() => void>();
let routeParams: Record<string, string | undefined> = { id: 'session-1' };
let pendingSessionRead: Deferred<Response> | null = null;
let sessionReadFails = false;
let sessionLastMobileSurfaceState: typeof import('@/sync/domains/state/navigationUiState')['sessionLastMobileSurfaceState'];

beforeEach(async () => {
    ({ sessionLastMobileSurfaceState } = await import('@/sync/domains/state/navigationUiState'));
    replacePersistentUiStateForTest(sessionLastMobileSurfaceState, {});
    phone = false;
    holdInteractionJobs = false;
    heldInteractionJobs.clear();
    routeParams = { id: 'session-1' };
    pendingSessionRead = null;
    sessionReadFails = false;
});

installSessionRouteCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        const readDimensions = () => ({ width: phone ? 390 : 1280, height: phone ? 844 : 900, scale: 1, fontScale: 1 });
        const native = await createReactNativeNativeMock({ platformOS: 'ios' }, {
            // Presentation geometry reads the SDK authority directly, not only its hook.
            Dimensions: { get: readDimensions },
            useWindowDimensions: readDimensions,
        });
        const interactionManager = native.InteractionManager;
        const sdkRunAfterInteractions = interactionManager.runAfterInteractions;
        interactionManager.runAfterInteractions = (callback: () => void) => {
            if (!holdInteractionJobs) return sdkRunAfterInteractions.call(interactionManager, callback);
            const job = () => { heldInteractionJobs.delete(job); callback(); };
            heldInteractionJobs.add(job);
            return { cancel: () => { heldInteractionJobs.delete(job); } };
        };
        Object.defineProperty(native.Platform, 'isPad', { configurable: true, get: () => !phone });
        return native;
    },
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ params: () => routeParams }).module;
    },
    nativeNavigation: async () => {
        const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
        // The native navigator is the SDK boundary. Render its initial scene so
        // the real shared shell, including its classic SessionView, is exercised.
        return createReactNavigationNativeMock({ renderInitialNavigatorScreen: true });
    },
});

// Runtime imports can reach route consumers through the shared graph. Configure
// their SDK boundaries first, so no consumer captures the default empty route.
const { createDeferred, createPlainSessionByIdResponseFixture, createRootLayoutFeaturesResponse,
    createSessionFixture, renderScreen, standardCleanup } = await import('@/dev/testkit');
const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
const { installSessionPaneRuntimeTestHarness } = await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
const { buildRealmQualifiedMobileSurfaceStorageKey } = await import('@/sync/domains/settings/mobileSurfacePersistence');
const { storage } = await import('@/sync/domains/state/storageStore');
const { replacePersistentUiStateForTest } = await import('@/dev/testkit/harness/persistentUiState');
const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');

const runtime = installSessionPaneRuntimeTestHarness({
    sessionId: 'session-1',
    features: () => createRootLayoutFeaturesResponse({ features: { terminal: { embeddedPty: { enabled: true } } } }),
    request: async (url, init) => {
        if ((init?.method ?? 'GET') !== 'GET' || new URL(String(url)).pathname !== '/v2/sessions/session-1') return null;
        if (pendingSessionRead) return (await pendingSessionRead.promise).clone();
        if (sessionReadFails) return Response.json({ error: 'unavailable' }, { status: 503 });
        return null;
    },
});

// Load the real graph once during collection, not inside each case's hook budget.
// Install the transport/SDK boundaries above before warming the registered Sync owner.
await loadSyncSingletonForTests();
const hydration = await import('@/hooks/session/useHydrateSessionForRoute');
const serverRuntime = await import('@/sync/domains/server/serverRuntime');
const terminalAvailability = await import('@/components/sessions/terminal/useSessionTerminalAvailability');
const { SessionView } = await import('@/components/sessions/shell/SessionView');
const { SessionCockpitShell } = await import('@/components/workspaceCockpit/session/SessionCockpitShell');
const { ActivitySpinner } = await import('@/components/ui/feedback/ActivitySpinner');
const { SurfaceStateCard } = await import('@/components/ui/surfaces/SurfaceStateCard');

let hydrateSessionForRouteSpy: MockInstance<typeof hydration.useHydrateSessionForRoute>;
let subscribeActiveServerSpy: MockInstance<typeof serverRuntime.subscribeActiveServer>;
let terminalAvailabilitySpy: MockInstance<typeof terminalAvailability.useSessionTerminalAvailability>;

beforeEach(async () => {
    storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'classic' });
    hydrateSessionForRouteSpy = vi.spyOn(hydration, 'useHydrateSessionForRoute');
    subscribeActiveServerSpy = vi.spyOn(serverRuntime, 'subscribeActiveServer');
    terminalAvailabilitySpy = vi.spyOn(terminalAvailability, 'useSessionTerminalAvailability');
});

afterEach(async () => {
    await standardCleanup();
    pendingSessionRead?.resolve(Response.json({ error: 'Session not found' }, { status: 404 }));
    heldInteractionJobs.clear();
    holdInteractionJobs = false;
    vi.restoreAllMocks();
});

function coldSession() {
    storage.setState({ sessions: {}, sessionListIndexByServerId: {}, sessionListRowsByServerId: {} });
}

function pendingHydration() {
    coldSession();
    pendingSessionRead = createDeferred<Response>();
    return pendingSessionRead;
}

function enableCockpit() {
    phone = true;
    storage.getState().applySettingsLocal({ mobileWorkspaceExperienceV1: 'cockpit' });
}

function rememberSurface(surface: 'tabs' | 'git') {
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Expected restored Account scope');
    const key = buildRealmQualifiedMobileSurfaceStorageKey('session', scope, 'session-1');
    if (!key) throw new Error('Expected qualified Session preference key');
    replacePersistentUiStateForTest(sessionLastMobileSurfaceState, { 'session-1': 'git', [key]: surface });
}

async function renderRoute() {
    const { default: SessionRoute } = await import('@/app/(app)/session/[id]');
    return renderScreen(<runtime.Wrapper><SessionRoute /></runtime.Wrapper>);
}

describe('session route index', () => {
    it('mounts the session view immediately on native instead of waiting for interaction deferral', async () => {
        holdInteractionJobs = true;
        const screen = await renderRoute();

        expect(heldInteractionJobs.size).toBeGreaterThan(0);
        expect(screen.findAllByType(SessionCockpitShell)).toHaveLength(1);
        expect(screen.findAllByType(SessionView)).toHaveLength(1);
        const [hydratedSessionId, hydrateTag] = hydrateSessionForRouteSpy.mock.calls.at(-1) ?? [];
        expect(hydratedSessionId).toBe('session-1');
        expect(String(hydrateTag)).toBe('SessionRoute.ensureSessionVisible gen=' + serverRuntime.getActiveServerSnapshot().generation);
        await act(async () => {
            holdInteractionJobs = false;
            for (const job of [...heldInteractionJobs]) job();
        });
        expect(screen.findAllByType(SessionView)).toHaveLength(1);
    });

    it('shows a loading spinner while hydration is pending and the session is not cached', async () => {
        pendingHydration();
        const screen = await renderRoute();

        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(1);
        expect(screen.findAllByType(SessionView)).toHaveLength(0);
        expect(screen.findAllByType(SessionCockpitShell)).toHaveLength(0);
    });

    it('mounts the session shell when hydration is retrying so retry status and navigation remain available', async () => {
        coldSession();
        sessionReadFails = true;
        routeParams.serverId = runtime.serverId;
        const screen = await renderRoute();

        await waitForHomeGovernance(() => expect(screen.findByType(SessionView).props.routeHydrationState?.kind).toBe('retrying'));
        expect(screen.findAllByType(SessionCockpitShell)).toHaveLength(1);
        const retryStatus = screen.findAllByType(SurfaceStateCard).find(node => node.props.testID === 'session-route-retrying');
        expect(retryStatus?.props.kind).toBe('loading');
        expect(screen.findAllByType(ActivitySpinner).length).toBeGreaterThan(0);
        const sessionView = screen.findByType(SessionView);
        expect(sessionView.props.routeHydrationState).toEqual({
            kind: 'retrying', sessionId: 'session-1', serverId: runtime.serverId, cause: 'unknown',
            retry: expect.any(Function),
        });
    });

    it('opens an exact-Home Session absent from the loaded list through by-id route hydration', async () => {
        routeParams.serverId = runtime.serverId;
        const pending = pendingHydration();
        // The Home harness serves empty active/query/history lists. Neither a list
        // row nor a test-owned store publication may satisfy this opened route.
        expect(storage.getState().sessions['session-1']).toBeUndefined();
        expect(storage.getState().sessionListRowsByServerId).toEqual({});
        const screen = await renderRoute();

        expect(screen.findAllByType(ActivitySpinner), JSON.stringify({
            routeParams,
            hydrationInput: hydrateSessionForRouteSpy.mock.calls.at(-1),
            activeServerId: serverRuntime.getActiveServerSnapshot().serverId,
            text: screen.getTextContent(),
            renderedIds: screen.findAll(node => typeof node.type === 'string' && typeof node.props.testID === 'string')
                .map(node => node.props.testID),
        })).toHaveLength(1);
        expect(screen.findAllByTestId('session-root-unavailable')).toHaveLength(0);
        const session = createSessionFixture({ id: 'session-1', serverId: runtime.serverId, seq: 0 });
        await act(async () => {
            pending.resolve(Response.json(createPlainSessionByIdResponseFixture(session)));
        });

        await waitForHomeGovernance(() => expect(screen.findByType(SessionView).props.routeHydrationState).toMatchObject({
            kind: 'available', sessionId: 'session-1', serverId: runtime.serverId,
        }));
        expect(storage.getState().sessions['session-1']).toMatchObject({ id: 'session-1', serverId: runtime.serverId });
        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(0);
        expect(screen.findAllByType(SessionView)).toHaveLength(1);
        expect(screen.findAllByTestId('session-root-unavailable')).toHaveLength(0);
    });

    it('shows a loading spinner before mounting the cockpit shell while hydration is pending', async () => {
        enableCockpit();
        pendingHydration();
        const screen = await renderRoute();

        expect(screen.findAllByType(ActivitySpinner)).toHaveLength(1);
        expect(screen.findAllByType(SessionView)).toHaveLength(0);
        expect(screen.findAllByType(SessionCockpitShell)).toHaveLength(0);
    });

    it('restores only the route Account realm-qualified mobile surface, never the legacy bare entry', async () => {
        enableCockpit();
        routeParams.serverId = runtime.serverId;
        rememberSurface('tabs');
        const screen = await renderRoute();
        const shells = screen.findAllByType(SessionCockpitShell);

        expect(shells).toHaveLength(1);
        expect(shells[0]?.props.surface).toBe('tabs');
    });

    it('rehydrates when active server listener reports a new generation', async () => {
        await renderRoute();
        expect(subscribeActiveServerSpy.mock.calls.at(-1)?.[0]).not.toBeNull();
        expect(subscribeActiveServerSpy.mock.calls.at(-1)?.[0]).toEqual(expect.any(Function));

        await act(async () => {
            await runtime.restoreRealm({ serverUrl: 'https://session-generation.test', serverIdentityId: 'srv_session_generation', accountId: 'account-a' });
        });

        expect(hydrateSessionForRouteSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
        const latestTag = hydrateSessionForRouteSpy.mock.calls.at(-1)?.[1] ?? '';
        expect(String(latestTag)).toBe('SessionRoute.ensureSessionVisible gen=' + serverRuntime.getActiveServerSnapshot().generation);
    });

    it('renders the session cockpit shell on phone when cockpit mode is enabled by default', async () => {
        enableCockpit();
        routeParams.serverId = runtime.serverId;
        rememberSurface('git');
        const screen = await renderRoute();

        const cockpit = screen.findByType(SessionCockpitShell);
        expect(cockpit.props.sessionId).toBe('session-1');
        expect(cockpit.props.scopeId).toBe('session:address:' + runtime.serverId + ':session-1');
        expect(cockpit.props.surface).toBe('git');
        expect(cockpit.props.routeServerId).toBe(runtime.serverId);
        // A non-chat cockpit surface is hosted inside the one Session chrome: the SessionView mounts
        // with that surface as its content instead of the transcript.
        const hosts = screen.findAllByType(SessionView);
        expect(hosts).toHaveLength(1);
        expect(hosts[0]?.props.contentOverride).toBeTruthy();
    });

    it('keeps the cockpit terminal surface when the viewed session server enables terminal', async () => {
        enableCockpit();
        routeParams = { id: 'session-1', serverId: runtime.serverId, mobileSurface: 'terminal' };
        const screen = await renderRoute();

        const cockpit = screen.findByType(SessionCockpitShell);
        expect(cockpit.props.surface).toBe('terminal');
    });

    it('scopes terminal availability to the viewed session id in cockpit mode', async () => {
        enableCockpit();
        routeParams = { id: 'session-scoped' };
        await renderRoute();

        expect(terminalAvailabilitySpy.mock.calls.length).toBeGreaterThan(0);
        expect(terminalAvailabilitySpy.mock.calls[0]?.[0]).toBeNull();
    });
});

// P03-TESTKIT-SERVER: the unconfigured test build seeds no Home; select one through the real owner.
beforeEach(async () => { await selectActiveTestHomeForTests(); });
