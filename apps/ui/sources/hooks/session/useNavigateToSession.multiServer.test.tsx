import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionFixture, renderScreen } from '@/dev/testkit';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installSessionRouteCommonModuleMocks } from '@/__tests__/routes/(app)/session/[id]/sessionRouteTestHelpers';
import { storage } from '@/sync/domains/state/storageStore';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Navigate = ReturnType<typeof import('./useNavigateToSession').useNavigateToSession>;
const routerNavigate = vi.fn<(href: unknown, options?: unknown) => void>();
installSessionRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { navigate: routerNavigate } }).module;
    },
});
const runtime = installSessionPaneRuntimeTestHarness();
let otherHome: Awaited<ReturnType<typeof import('@/sync/domains/server/serverProfiles').upsertServerProfile>>;
let navigate: Navigate;
let NavigationProbe: React.FC;
let telemetryEnabled = false;

beforeEach(async () => {
    routerNavigate.mockClear();
    const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
    otherHome = await upsertServerProfile({ serverUrl: 'https://navigation-other.test', name: 'Other Home' });
    // Two real saved Homes share this synthetic plain Account. HTTP is the
    // external boundary; connection selection and Account admission remain real.
    const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
    setRuntimeFetch(async (url) => {
        const request = new URL(String(url));
        if (!['https://session-pane.test', otherHome.serverUrl].includes(request.origin)) {
            throw new Error('Unexpected navigation test origin');
        }
        const json = (value: unknown) => new Response(JSON.stringify(value));
        if (request.pathname === '/v1/auth/ping') return json({});
        if (request.pathname === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 1 });
        if (request.pathname === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture());
        if (request.pathname === '/v1/features' || request.pathname === '/v1/features/authenticated') return json(createRootLayoutFeaturesResponse());
        return new Response('{}', { status: 404 });
    });
    const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
    const { clearSessionUiTelemetryMarks } = await import('@/sync/runtime/performance/sessionUiTelemetry');
    telemetryEnabled = syncPerformanceTelemetry.isEnabled();
    syncPerformanceTelemetry.configure({ enabled: true });
    syncPerformanceTelemetry.reset();
    clearSessionUiTelemetryMarks();
});

afterEach(async () => {
    const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
    const { clearSessionUiTelemetryMarks } = await import('@/sync/runtime/performance/sessionUiTelemetry');
    clearSessionUiTelemetryMarks();
    syncPerformanceTelemetry.configure({ enabled: telemetryEnabled });
});

async function renderProbe() {
    const { useNavigateToSession } = await import('./useNavigateToSession');
    NavigationProbe = function Probe() { navigate = useNavigateToSession(); return null; };
    return renderScreen(<runtime.Wrapper><NavigationProbe /></runtime.Wrapper>);
}

function seedPreferredHome(sessionId: string, serverId: string) {
    const membership = Object.fromEntries(Object.entries(storage.getState().ordinarySessionListMembershipByServerId)
        .map(([home, ids]) => [home, ids?.filter((id) => id !== sessionId)]));
    storage.setState({ ordinarySessionListMembershipByServerId: membership });
    storage.getState().applySessions([createSessionFixture({ id: sessionId, serverId })]);
}

async function settleSwitches() {
    const { setActiveServerAndSwitch } = await import('@/sync/domains/server/activeServerSwitch');
    // The public owner's serialized operation drains the prior navigation switch
    // and restores the fixture Home before its Account is disposed.
    await setActiveServerAndSwitch({ serverId: runtime.serverId, scope: 'tab' });
}

function expectRoute(href: string) {
    expect(routerNavigate).toHaveBeenLastCalledWith(href, expect.any(Object));
    const options = routerNavigate.mock.calls.at(-1)?.[1];
    const singular = options && typeof options === 'object' && 'dangerouslySingular' in options ? options.dangerouslySingular : null;
    expect(singular).toEqual(expect.any(Function));
    if (typeof singular === 'function') expect(singular('session', { id: 'session' })).toBe('session');
}

describe('useNavigateToSession (multi-server)', () => {
    it('navigates from a hosted session through the owning tab and preserves the exact Home', async () => {
        const { useNavigateToSession } = await import('./useNavigateToSession');
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const push = vi.fn();
        function Probe() { navigate = useNavigateToSession(); return null; }
        await renderScreen(<runtime.Wrapper>
            <DestinationInstanceHost tabId="session-tab" ref={{ kind: 'session', params: { id: 'A', serverId: runtime.serverId } }}
                pathname="/session/A" focused visible navigation={{ push, replace: vi.fn(), back: vi.fn() }}>
                <Probe />
            </DestinationInstanceHost>
        </runtime.Wrapper>);
        try {
            await act(async () => { await navigate('B', { serverId: otherHome.id }); });
            expect(push).toHaveBeenCalledWith('/session/B?serverId=' + otherHome.id, expect.any(Object));
            expect(routerNavigate).not.toHaveBeenCalled();
        } finally { await settleSwitches(); }
    });

    it('navigates immediately while the real Home switch waits for credentials', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://session-pane.test');
        let release!: () => void;
        let started!: () => void;
        const requested = new Promise<void>((resolve) => { started = resolve; });
        const pending = new Promise<void>((resolve) => { release = resolve; });
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (url) => {
            if (url === otherHome.serverUrl) { started(); await pending; }
            return credentials;
        });
        await renderProbe();
        try {
            await act(async () => { await navigate('sess_123', { serverId: otherHome.id }); });
            expectRoute('/session/sess_123?serverId=' + otherHome.id);
            expect(routerNavigate).toHaveBeenCalledTimes(1);
            await requested;
            // Navigation completed even though the credential read is still pending.
            expectRoute('/session/sess_123?serverId=' + otherHome.id);
        } finally { release(); await settleSwitches(); }
    });

    it('keeps the exact target route when the parallel active-Home switch fails', async () => {
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const credentials = await TokenStorage.getCredentialsForServerUrl('https://session-pane.test');
        vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async (url) => {
            if (url === otherHome.serverUrl) throw new Error('credential storage unavailable');
            return credentials;
        });
        await renderProbe();
        await act(async () => { await navigate('same-session', { serverId: otherHome.id }); });
        await settleSwitches();
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        expect(getActiveServerSnapshot().serverId).toBe(runtime.serverId);
        expectRoute('/session/same-session?serverId=' + otherHome.id);
        expect(routerNavigate).toHaveBeenCalledTimes(1);
    });

    it('selects a saved target Home when serverId is provided', async () => {
        await renderProbe();
        try {
            await act(async () => { await navigate('sess_456', { serverId: otherHome.id }); });
            const { setActiveServerAndSwitch } = await import('@/sync/domains/server/activeServerSwitch');
            await setActiveServerAndSwitch({ serverId: otherHome.id, scope: 'tab' });
            const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
            expect(getActiveServerSnapshot().serverId).toBe(otherHome.id);
            expectRoute('/session/sess_456?serverId=' + otherHome.id);
        } finally { await settleSwitches(); }
    });

    it('resolves the preferred Home from actual local Session state when serverId is omitted', async () => {
        seedPreferredHome('sess_789', otherHome.id);
        await renderProbe();
        try {
            await act(async () => { await navigate('sess_789'); });
            expectRoute('/session/sess_789?serverId=' + otherHome.id);
        } finally { await settleSwitches(); }
    });

    it('recomputes the preferred Home after the Session state changes and the caller rerenders', async () => {
        seedPreferredHome('sess_999', runtime.serverId);
        const screen = await renderProbe();
        await act(async () => { await navigate('sess_999'); });
        expectRoute('/session/sess_999?serverId=' + runtime.serverId);
        seedPreferredHome('sess_999', otherHome.id);
        await screen.update(<runtime.Wrapper><NavigationProbe /></runtime.Wrapper>);
        try {
            await act(async () => { await navigate('sess_999'); });
            expectRoute('/session/sess_999?serverId=' + otherHome.id);
        } finally { await settleSwitches(); }
    });

    it('normalizes whitespace around the Session id before resolving and navigating', async () => {
        seedPreferredHome('sess_whitespace', runtime.serverId);
        await renderProbe();
        await act(async () => { await navigate('  sess_whitespace  '); });
        expectRoute('/session/sess_whitespace?serverId=' + runtime.serverId);
        await settleSwitches();
    });

    it('hands an unresolved bare Session id to the route without guessing a Home and records the open request', async () => {
        await renderProbe();
        await act(async () => { await navigate('shared-session', { query: { jumpSeq: 7 } }); });
        await settleSwitches();
        expectRoute('/session/shared-session?jumpSeq=7');
        expect(routerNavigate).toHaveBeenCalledTimes(1);
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        expect(getActiveServerSnapshot().serverId).toBe(runtime.serverId);
        const { recordSessionOpenPaintForSessionUiTelemetry } = await import('@/sync/runtime/performance/sessionUiTelemetry');
        recordSessionOpenPaintForSessionUiTelemetry({
            sessionId: 'shared-session', phase: 'firstPaint', committedMessages: 0, items: 0,
            native: 0, web: 1, routeHydrationPending: 1,
        });
        const { syncPerformanceTelemetry } = await import('@/sync/runtime/syncPerformanceTelemetry');
        expect(syncPerformanceTelemetry.snapshot().events.find((event) => event.name === 'ui.sessions.transcript.openToFirstPaint'))
            .toMatchObject({ count: 1, fields: { sourceNavigateHook: 1, sourceRouteEntry: 0 } });
    });
});
