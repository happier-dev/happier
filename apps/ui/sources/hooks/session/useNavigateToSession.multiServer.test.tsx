import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSessionRouteCommonModuleMocks } from '@/__tests__/routes/(app)/session/[id]/sessionRouteTestHelpers';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Navigate = ReturnType<typeof import('./useNavigateToSession').useNavigateToSession>;
const routerNavigate = vi.fn<(href: unknown, options?: unknown) => void>();
installSessionRouteCommonModuleMocks({
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ router: { navigate: routerNavigate } }).module;
    },
});
// Install router boundary options before the real pane/runtime import graph
// reaches Expo; otherwise its cached module has only the default router methods.
const { createSessionFixture, renderScreen } = await import('@/dev/testkit');
const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
const { installBrowserRuntimeForTests } = await import('@/dev/testkit/harness/browserRuntimeHarness');
const { installSessionPaneRuntimeTestHarness } = await import('@/components/sessions/panes/sessionPaneRuntimeTestHarness');
const { storage } = await import('@/sync/domains/state/storageStore');
let browser: Awaited<ReturnType<typeof installBrowserRuntimeForTests>>;
// The route fixture is web, so tab focus needs the actual Window/sessionStorage
// boundary before the Account and pane lifetime starts.
beforeEach(async () => { browser = await installBrowserRuntimeForTests({ url: 'https://session-pane.test/' }); });
afterEach(() => { browser?.restore(); });
const runtime = installSessionPaneRuntimeTestHarness();
let otherHome: Awaited<ReturnType<typeof import('@/sync/domains/server/serverProfiles').upsertServerProfile>>;
let navigate: Navigate;
let NavigationProbe: React.FC;
let telemetryEnabled = false;
let rollbackOtherHomeCredentials: (() => Promise<boolean>) | undefined;

beforeEach(async () => {
    routerNavigate.mockClear();
    const { upsertServerProfile } = await import('@/sync/domains/server/serverProfiles');
    otherHome = await upsertServerProfile({ serverUrl: 'https://navigation-other.test', name: 'Other Home' });
    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://session-pane.test', { serverId: runtime.serverId });
    if (!credentials) throw new Error('The navigation fixture has no restored Account credential');
    const write = await TokenStorage.setCredentialsForServerUrlWithRollback(otherHome.serverUrl, { serverId: otherHome.id }, credentials);
    if (!write) throw new Error('The navigation fixture could not credential its second Home');
    rollbackOtherHomeCredentials = () => write.rollback();
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
    vi.restoreAllMocks();
    await rollbackOtherHomeCredentials?.();
    rollbackOtherHomeCredentials = undefined;
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
    it('opens the exact committed message route on its Home without requiring a Pending input', async () => {
        await renderProbe();
        try {
            for (const messageId of ['committed-first', 'committed-second']) {
                await act(async () => { await navigate('source-session', { serverId: otherHome.id, messageId }); });
                expectRoute('/session/source-session/message/' + encodeURIComponent('server:' + messageId) + '?serverId=' + otherHome.id);
            }
        } finally { await settleSwitches(); }
    });

    it('lets the Home selector return to B after Search opens a Session on A', async () => {
        const { AccountPopoverContent } = await import('@/components/navigation/accountPopover/AccountPopoverContent');
        const { useActiveServerSnapshot } = await import('@/hooks/server/useActiveServerSnapshot');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { listServerProfiles, resolveServerProfileScopeId } = await import('@/sync/domains/server/serverProfiles');
        const { listServerSelectionTargets } = await import('@/sync/domains/server/selection/serverSelectionResolver');
        const { updateEffectiveHomeViewState } = await import('@/sync/domains/server/selection/homeViewSelectionState');
        const { resolveHomeConnectionSummary } = await import('@/components/navigation/connectionStatus/resolveHomeConnectionSummary');
        const { setActiveServerAndSwitch } = await import('@/sync/domains/server/activeServerSwitch');
        const { useNavigateToSession } = await import('./useNavigateToSession');
        await updateEffectiveHomeViewState(() => ({
            version: 1, groups: [], activeTargetKind: 'server', activeTargetId: runtime.serverId,
        }), { scope: 'tab' });
        function Probe() {
            navigate = useNavigateToSession();
            const active = useActiveServerSnapshot();
            const servers = listServerProfiles();
            return <AccountPopoverContent step="root" onStepChange={() => {}}
                servers={servers} targets={listServerSelectionTargets({
                    serverProfiles: servers.map((profile) => ({ ...profile, id: resolveServerProfileScopeId(profile) })),
                    groupProfiles: [],
                })}
                activeGroupId={null} activeServerId={active.serverId}
                displayServerId={active.serverId} displayServerProfile={servers.find((s) => s.id === active.serverId) ?? null}
                displayHomeLabel="Home" pendingServerId={null}
                homeSummary={resolveHomeConnectionSummary({ healthKind: 'healthy' })}
                machineSummary={{ kind: 'unknown' }} showsMachineGuidance={false}
                runtimeOrigin={null} homeCarrier={null} retryBusy={false}
                switchServer={(serverId, scope) => setActiveServerAndSwitch({ serverId, scope })}
                onRetry={async () => {}} onRestore={() => {}} onAddHome={() => {}}
                onManageHomes={() => {}} onOpenSettings={() => {}} onClose={() => {}} renderDetails={() => null}
            />;
        }
        const screen = await renderScreen(<runtime.Wrapper><Probe /></runtime.Wrapper>);
        try {
            await act(async () => { await navigate('search-result-on-a', { serverId: otherHome.id }); });
            expect(getActiveServerSnapshot().serverId).toBe(otherHome.id);
            expectRoute('/session/search-result-on-a?serverId=' + otherHome.id);
            const { SelectableRow } = await import('@/components/ui/lists/SelectableRow');
            const row = screen.findAllByType(SelectableRow).find((item) =>
                item.props.testID === 'connection-popover-home-server-' + runtime.serverId);
            expect(row).toBeDefined();
            await act(async () => { await row!.props.onPress(); });
            expect(getActiveServerSnapshot().serverId).toBe(runtime.serverId);
        } finally { await settleSwitches(); }
    });

    it('opens another Home through the root router rather than the retired source tab', async () => {
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
            expectRoute('/session/B?serverId=' + otherHome.id);
            expect(push).not.toHaveBeenCalled();
        } finally { await settleSwitches(); }
    });

    it('keeps navigation within the owning tab when the Home stays active', async () => {
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
        await act(async () => { await navigate('B', { serverId: runtime.serverId }); });
        expect(push).toHaveBeenCalledWith('/session/B?serverId=' + runtime.serverId, expect.any(Object));
        expect(routerNavigate).not.toHaveBeenCalled();
    });

    it('opens the target Session only after its Home switch and Account refresh settle', async () => {
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
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const homesAtNavigation: string[] = [];
        routerNavigate.mockImplementation(() => { homesAtNavigation.push(getActiveServerSnapshot().serverId); });
        let navigation: Promise<void> | undefined;
        try {
            await act(async () => {
                navigation = navigate('sess_123', { serverId: otherHome.id });
                await requested;
            });
            expect(routerNavigate).not.toHaveBeenCalled();
            await act(async () => { release(); await navigation; });
            expectRoute('/session/sess_123?serverId=' + otherHome.id);
            expect(homesAtNavigation).toEqual([otherHome.id]);
        } finally { release(); await navigation; routerNavigate.mockReset(); await settleSwitches(); }
    });

    it('keeps the exact target recovery route after an active-Home switch fails', async () => {
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
