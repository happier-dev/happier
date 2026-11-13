import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { MACHINE_PLAIN_DATA_KEY_MARKER} from '@happier-dev/protocol/machines/machineStoredContent';
import { CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD,
    CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD, type ConnectedAccountDaemonControlResponse } from '@happier-dev/protocol/connect/connectedAccountDaemonRpcV1';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { setActionApprovalOverride } from '@happier-dev/protocol/actions/actionSettings';

// Native rendering/router and credentials are boundaries. Warm callback cases
// retain the real mounted Action hook, executor and same-Account HTTP lookup.
const callbackBoundary = vi.hoisted(() => ({ active: false }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/auth/context/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock('expo-router', async () => {
    const router = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock();
    const native = await import('@react-navigation/core');
    return { ...router.module,
        useNavigation: () => callbackBoundary.active ? native.useNavigation() : router.module.useNavigation(),
        useLocalSearchParams: () => callbackBoundary.active ? native.useRoute().params ?? {} : router.module.useLocalSearchParams(),
    };
});

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const outgoing: SocketRpcRequestPayload[] = [];
const answers: unknown[] = [];
const rpcFailures: unknown[] = [];
installDisconnectedServerSocketBoundary((socket) => {
    configureConnectedServerSocketBoundary(socket);
    vi.spyOn(socket, 'timeout').mockReturnValue(socket);
    socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (_event, payload: SocketRpcRequestPayload) => {
        outgoing.push(payload);
        if (rpcFailures.length) return rpcFailures.shift();
        if (!answers.length) throw new Error('Unexpected connected-account daemon request');
        return { ok: true, result: answers.shift() };
    });
});
// Compile the real Sync graph during module bootstrap, outside per-case lifecycle hooks.
await import('@/sync/syncEngine');
const service = { pluginId: 'acme.accounts', localId: 'work' } as const;
const beginConnect = { operation: 'beginConnect', service, modeId: 'manual' } as const;
const machineRow = { machine: createPlainMachineRowFixture({ id: 'machine-1', accountId: 'account-a' }) };
let serverId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
let syncBridge: Awaited<ReturnType<typeof import('@/dev/testkit/harness/syncSingletonLoader')['loadSyncSingletonForTests']>>;
let restoreCallbackApproval: (() => void) | undefined;

async function waiveCallbackApproval() {
    const { storage } = await import('@/sync/domains/state/storage');
    const previous = storage.getState().settings.actionsSettingsV1;
    const actionsSettingsV1 = setActionApprovalOverride({ settings: previous,
        actionId: 'connectedServices.authentication.completeOAuth', surface: 'ui', approvalRequired: false });
    // These cases exercise callback transport/return custody; approval has its own real-wiring cases below.
    homes.answer(serverId, '/v2/account/settings', { body: {
        content: { t: 'plain', v: { ...storage.getState().settings, actionsSettingsV1 } },
        version: (storage.getState().settingsVersion ?? 0) + 1,
    } });
    storage.getState().applySettingsLocal({ actionsSettingsV1 });
    restoreCallbackApproval = () => storage.getState().applySettingsLocal({ actionsSettingsV1: previous });
}

function answerAddressedOAuthAttempt(attemptId: string, machineId: string,
    attemptService: Readonly<{ pluginId: string; localId: string }> = service) {
    homes.answer(serverId, `/v2/connect/connected-account-attempt-transactions/${attemptId}`, { body: {
        kind: 'oauth', revision: 1, content: { t: 'plain', v: {} }, expiresAtMs: Date.now() + 60_000,
        scope: { machineId, service: attemptService, modeId: 'oauth', intent: 'connect',
            phase: 'awaitingOAuth', createdAtMs: Date.now() },
    } });
}

describe('connected-account daemon machine RPC', () => {
    beforeEach(async () => {
        // restoreAllMocks retires the credential-store boundary after each case.
        installHomeGovernanceBoundaries(homes);
        const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
        syncBridge = await loadSyncSingletonForTests();
        serverId = await homes.addHome({ name: 'Accounts Home', serverUrl: 'https://connected-accounts.test', accountId: 'account-a' });
        homes.answer(serverId, '/v1/machines/machine-1', { body: machineRow });
        connection = await restoreServerAccountForTest({ serverUrl: 'https://connected-accounts.test', accountId: 'account-a', request: homes.request });
        outgoing.length = 0;
        answers.length = 0;
        rpcFailures.length = 0;
    });
    afterEach(async () => {
        restoreCallbackApproval?.();
        restoreCallbackApproval = undefined;
        const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
        const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
        serverScopedRpcSocketPool.resetForTests();
        resetScopedMachineTransportCacheForTests();
        await connection?.dispose();
        syncBridge?.dispose();
        await homes.reset();
        vi.restoreAllMocks();
    });
    it('rejects response shapes outside the daemon wire contract', async () => {
        const { ConnectedAccountAttemptResponseSchema } = await import('./connectedAccountDaemon');
        expect(ConnectedAccountAttemptResponseSchema.safeParse({ status: 'awaitingOAuth', attemptId: 'attempt-1',
            authorizationUrl: 'not-a-url', callbackUrl: 'http://127.0.0.1/callback' }).success).toBe(false);
        expect(ConnectedAccountAttemptResponseSchema.safeParse({ status: 'awaitingDeviceAuthorization', attemptId: 'attempt-1',
            verificationUri: 'https://example.com/' + 'x'.repeat(8192), pollIntervalMs: 0 }).success).toBe(false);
        expect(ConnectedAccountAttemptResponseSchema.safeParse({ status: 'pending', attemptId: 'attempt-1', retryAfterMs: 1.5 }).success).toBe(false);
    });
    it('refuses retired controller custody before recapturing an authentication Action', async () => {
        const { captureActiveServerAccountScopeCurrentness } = await import('@/sync/domains/scope/activeServerAccountScope');
        const captured = captureActiveServerAccountScopeCurrentness();
        expect(captured.isCurrent()).toBe(true);
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ profileScope: { serverId, accountId: 'successor' } });
        expect(captured.isCurrent()).toBe(false);
        const { runConnectedAccountAuthenticationAction } = await import('./connectedAccountDaemon');
        await expect(runConnectedAccountAuthenticationAction({ serverId, machineId: 'machine-1', expectedAccountId: 'account-a',
            assertCurrent: () => {
                if (!captured.isCurrent()) throw Object.assign(new Error('scope-retired'), { code: 'scope-retired' });
            }, command: { operation: 'cancel', attemptId: 'discarded-attempt' } })).rejects.toMatchObject({ code: 'scope-retired' });
        expect(outgoing).toEqual([]);
    });
    it('keeps approved pending discovery on its mounted exact Home continuation instead of treating the Artifact as a daemon reply', async () => {
        const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
        const { listPendingConnectedAccountAuthenticationActions } = await import('./connectedAccountDaemon');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const scope = { serverId, accountId: 'account-a' };
        let execution: ReturnType<typeof useMountedActionExecution> | undefined;
        function Probe() { execution = useMountedActionExecution(scope); return null; }
        const issuedConnectedCommands = () => outgoing.filter(request => request.method
            === `machine-1:${CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD}`
            || request.method === `machine-1:${CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD}`);
        await homes.requireUiApproval(serverId, 'connectedServices.authentication.pending.list');
        const screen = await renderScreen(React.createElement(Probe));
        let operation: Promise<unknown> | undefined;
        try {
            await vi.waitFor(() => expect(execution?.ready).toBe(true));
            const mounted = execution;
            if (!mounted) throw new Error('missing_mounted_execution');
            operation = listPendingConnectedAccountAuthenticationActions({ serverId, machineId: 'machine-1',
                expectedAccountId: scope.accountId, service, executeAction: mounted.execute });
            const outcome = operation.then(result => ({ result }), error => ({ error }));
            await vi.waitFor(() => expect(execution?.approval.approvalId).toEqual(expect.any(String)));
            expect(issuedConnectedCommands()).toEqual([]);
            const artifactId = execution?.approval.approvalId;
            if (!artifactId) throw new Error('missing_pending_approval');
            expect(homes.artifacts(serverId).readPlainBody(artifactId)).toContain('"machineId":"machine-1"');
            await act(async () => {
                expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId, decision: 'reject' },
                    { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: scope.accountId }))
                    .toMatchObject({ ok: true });
            });
            expect(await outcome).toMatchObject({ error: { code: 'approval_rejected' } });
            expect(issuedConnectedCommands()).toEqual([]);
        } finally { await screen.unmount(); await operation?.catch(() => {}); }
    });
    it('routes authentication through the exact server and machine owner', async () => {
        answers.push({ status: 'awaitingManual', attemptId: 'attempt-1' });
        const { runConnectedAccountAuthenticationCommand } = await import('./connectedAccountDaemon');
        await expect(runConnectedAccountAuthenticationCommand({ serverId, machineId: 'machine-1', command: beginConnect }))
            .resolves.toEqual({ status: 'awaitingManual', attemptId: 'attempt-1' });
        expect(outgoing).toMatchObject([{ method: 'machine-1:daemon.connectedAccounts.authentication.command',
            params: { v: 1, machineId: 'machine-1', command: beginConnect } }]);
        expect(homes.requestsFor('/v1/machines/read-batch')[0]?.serverId).toBe(serverId);
    });
    it('recovers an addressed Machine attempt without reading the Machine inventory', async () => {
        await waiveCallbackApproval();
        const { completeConnectedAccountOAuthCallback } = await import('./connectedAccountOAuthCallback');
        const { CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1 } = await import('@happier-dev/protocol/connect/oauthAuthorizationResponse');
        const attemptId = 'addressed-attempt';
        answerAddressedOAuthAttempt(attemptId, 'machine-1');
        answers.push({ status: 'awaitingOAuth', attemptId, callbackUrl: CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1 },
            { status: 'connected', attemptId, account: { service, accountId: 'addressed-account' } });
        const readMachines = vi.fn(async () => []);
        const account = { serverId, expectedAccountId: 'account-a', assertCurrent() {}, readMachines };
        const outcome = await completeConnectedAccountOAuthCallback({
            callbackUrl: `${CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1}?code=code&state=${attemptId}.nonce`,
            account,
        });
        expect(outcome).toEqual({ kind: 'connected', returnTo: '/settings/connected-services' });
        expect(readMachines).not.toHaveBeenCalled();
        expect(homes.requestsFor('/v1/machines')).toEqual([]);
        expect(outgoing.filter(request => request.method.endsWith(CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD))).toEqual([]);
        expect(outgoing.filter(request => request.method.endsWith(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD)))
            .toHaveLength(2);
    });
    it('completes the MCP callback on its addressed Machine through the real Action and socket owners', async () => {
        await waiveCallbackApproval();
        const { completeMcpOAuthCallback } = await import('./mcpOAuthCallback');
        const { MCP_OAUTH_CALLBACK_URL_V1, MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1 } = await import('@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1');
        homes.answer(serverId, '/v1/machines/machine-2', { body: { machine: createPlainMachineRowFixture({ id: 'machine-2', accountId: 'account-a' }) } });
        const attemptId = 'attempt.with.dots';
        answerAddressedOAuthAttempt(attemptId, 'machine-2', MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1);
        answers.push(
            { status: 'awaitingOAuth', attemptId, callbackUrl: MCP_OAUTH_CALLBACK_URL_V1 },
            { status: 'connected', attemptId,
                account: { service: { pluginId: 'happier', localId: 'mcp-sign-in' }, accountId: 'server-id' } },
        );
        let stripped = false;
        const callbackUrl = `${MCP_OAUTH_CALLBACK_URL_V1}?code=code-1&state=attempt.with.dots.nonce&iss=https%3A%2F%2Fissuer.example`;
        const outcome = await completeMcpOAuthCallback({ callbackUrl, browser: {
            replaceUrl: path => { expect(path).toBe('/oauth/mcp/callback'); stripped = true; }, close() {},
        }, account: { serverId, expectedAccountId: 'account-a', assertCurrent() {
            expect(stripped).toBe(true);
        }, returnTo: 'https://foreign.example' } });
        expect(outcome).toEqual({ kind: 'connected', returnTo: '/settings/mcp/server-id' });
        const issued = outgoing.filter(request => request.method.endsWith(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD)
            || request.method.endsWith(CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD));
        expect(issued).toMatchObject([
            { method: `machine-2:${CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD}`, params: { command: {
                operation: 'read', attemptId: 'attempt.with.dots',
            } } },
            { method: `machine-2:${CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD}`, params: { command: {
                operation: 'completeOAuth', attemptId: 'attempt.with.dots', completion: {
                    code: 'code-1', state: 'attempt.with.dots.nonce', iss: 'https://issuer.example', callbackUrl: MCP_OAUTH_CALLBACK_URL_V1,
                },
            } } },
        ]);
    });
    it.each(['connected', 'alreadyConnected', 'wrongCallback', 'stale'] as const)('routes the generic exact attempt through the real Action/socket owners without a service catalog (%s)', async result => {
        await waiveCallbackApproval();
        const { completeConnectedAccountOAuthCallback } = await import('./connectedAccountOAuthCallback');
        const { CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1 } = await import('@happier-dev/protocol/connect/oauthAuthorizationResponse');
        homes.answer(serverId, '/v1/machines/machine-2', { body: { machine: createPlainMachineRowFixture({ id: 'machine-2', accountId: 'account-a' }) } });
        answerAddressedOAuthAttempt('attempt.with.dots', 'machine-2');
        const connected = { status: 'connected', attemptId: 'attempt.with.dots', account: { service, accountId: 'generic-account' } };
        answers.push(
            result === 'stale' ? { status: 'rejected', attemptId: 'attempt.with.dots', code: 'attempt_expired' }
                : result === 'alreadyConnected' ? connected
                : { status: 'awaitingOAuth', attemptId: 'attempt.with.dots', callbackUrl: result === 'wrongCallback'
                    ? 'https://other.example/callback' : CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1 });
        if (result === 'connected') answers.push(connected);
        const callbackUrl = `${CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1}?code=code-1&state=attempt.with.dots.nonce&iss=`;
        const outcome = await completeConnectedAccountOAuthCallback({ callbackUrl, account: {
            serverId, expectedAccountId: 'account-a', assertCurrent() {},
        } });
        const readRequestId = outgoing.find(request => request.method.endsWith(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD))?.requestId;
        expect(readRequestId).toEqual(expect.any(String));
        expect(outcome).toEqual(result === 'connected' || result === 'alreadyConnected'
            ? { kind: 'connected', returnTo: '/settings/connected-services' }
            : { kind: 'unfinished', callbackUrl, response: result === 'stale'
                ? { requestId: readRequestId, status: 'rejected', attemptId: 'attempt.with.dots', code: 'attempt_expired' }
                : { requestId: readRequestId, status: 'awaitingOAuth', attemptId: 'attempt.with.dots', callbackUrl: 'https://other.example/callback' } });
        const issued = outgoing.filter(request => request.method.endsWith(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD)
            || request.method.endsWith(CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD));
        expect(issued).toMatchObject([
            { method: `machine-2:${CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD}`, params: { command: {
                operation: 'read', attemptId: 'attempt.with.dots',
            } } },
            ...(result === 'connected' ? [{ method: `machine-2:${CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD}`, params: { command: {
                operation: 'completeOAuth', attemptId: 'attempt.with.dots', completion: { code: 'code-1', state: 'attempt.with.dots.nonce',
                    iss: '', callbackUrl: CONNECTED_ACCOUNT_OAUTH_CALLBACK_URL_V1 },
            } } }] : []),
        ]);
        expect(issued).toHaveLength(result === 'connected' ? 2 : 1);
        expect(answers).toEqual([]);
    });
    it('uses the addressed attempt Machine and preserves its internal return destination', async () => {
        await waiveCallbackApproval();
        const { completeMcpOAuthCallback } = await import('./mcpOAuthCallback');
        const { MCP_OAUTH_CALLBACK_URL_V1, MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1 } = await import('@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1');
        answerAddressedOAuthAttempt('retained-attempt', 'machine-1', MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1);
        answers.push(
            { status: 'awaitingOAuth', attemptId: 'retained-attempt', callbackUrl: MCP_OAUTH_CALLBACK_URL_V1 },
            { status: 'connected', attemptId: 'retained-attempt',
                account: { service: MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1, accountId: 'server-id' } },
        );
        expect(await completeMcpOAuthCallback({
            callbackUrl: `${MCP_OAUTH_CALLBACK_URL_V1}?code=code&state=retained-attempt.nonce`,
            account: { serverId, expectedAccountId: 'account-a', assertCurrent() {},
                returnTo: '/session/session-1?capabilities=open' },
        })).toEqual({ kind: 'connected', returnTo: '/session/session-1?capabilities=open' });
        const issued = outgoing.filter(request => request.method.endsWith(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD)
            || request.method.endsWith(CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD));
        expect(issued).toHaveLength(2);
        expect(issued[1]).toMatchObject({ params: { command: { operation: 'completeOAuth',
            attemptId: 'retained-attempt', completion: { code: 'code', state: 'retained-attempt.nonce', callbackUrl: MCP_OAUTH_CALLBACK_URL_V1 } } } });
    });
    it.each([true, false])('consumes the originating Session return only for its exact OAuth attempt (matches=%s)', async matches => {
        await waiveCallbackApproval();
        const { completeMcpOAuthCallback } = await import('./mcpOAuthCallback');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { MCP_OAUTH_CALLBACK_URL_V1, MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1 } = await import('@happier-dev/protocol/mcp/oauth/mcpOAuthClientIdentityV1');
        answerAddressedOAuthAttempt('retained-attempt', 'machine-1', MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1);
        expect(await TokenStorage.setPendingExternalConnect({ provider: matches ? 'mcp:retained-attempt' : 'mcp:other-attempt',
            serverId, serverUrl: 'https://connected-accounts.test', returnTo: '/session/session-1?capabilities=open' })).toBe(true);
        answers.push({ status: 'awaitingOAuth', attemptId: 'retained-attempt', callbackUrl: MCP_OAUTH_CALLBACK_URL_V1 },
            { status: 'connected', attemptId: 'retained-attempt', account: { service: MCP_SIGN_IN_CONNECTED_SERVICE_REF_V1, accountId: 'server-id' } });
        expect(await completeMcpOAuthCallback({ callbackUrl: `${MCP_OAUTH_CALLBACK_URL_V1}?code=code&state=retained-attempt.nonce`,
            account: { serverId, expectedAccountId: 'account-a', assertCurrent() {} } }))
            .toMatchObject({ kind: 'connected', returnTo: matches ? '/session/session-1?capabilities=open' : '/settings/mcp/server-id' });
        expect(await TokenStorage.getPendingExternalConnect()).toEqual(matches ? null : expect.objectContaining({ provider: 'mcp:other-attempt' }));
        await TokenStorage.clearPendingExternalConnect();
    });

    it.each([
        { path: '/oauth/connected-account/callback', prefix: 'connected-account-oauth-callback' },
        { path: '/oauth/mcp/callback', prefix: 'mcp-oauth-callback' },
    ] as const)('warm callback $path offers Paste after the same-Account lookup finds no attempt', async ({ path, prefix }) => {
        const { BaseNavigationContainer, createNavigationContainerRef, createNavigatorFactory,
            getPathFromState, useNavigationBuilder } = await import('@react-navigation/core');
        const { StackActions, StackRouter } = await import('@react-navigation/routers');
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { resolveHref } = await import('expo-router/build/link/href');
        const { default: Route } = path.includes('/mcp/')
            ? await import('@/app/(app)/oauth/mcp/callback')
            : await import('@/app/(app)/oauth/connected-account/callback');
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ settingsScope: { serverId, accountId: 'account-a' } });
        homes.answer(serverId, '/v2/connect/connected-account-attempt-transactions/missing-attempt', {
            status: 404, body: { error: 'connected_account_attempt_transaction_not_found' },
        });
        callbackBoundary.active = true;
        const browser = globalThis as unknown as Record<string, unknown>;
        const browserKeys = ['location', 'history', 'opener', 'navigator'];
        const previous = Object.fromEntries(browserKeys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
        browser.location = new URL('https://app.happier.dev/settings/connected-services');
        browser.opener = null;
        const copy = vi.fn(async (_value: string) => {});
        Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: copy } } });
        browser.history = { state: null, replaceState(_state: unknown, _unused: string, href: string) {
            browser.location = new URL(href, 'https://app.happier.dev');
        } };
        const native = createNavigationContainerRef();
        const config = { screens: { credentials: 'settings/connected-services', callback: path.slice(1) } };
        function Navigator({ children }: React.PropsWithChildren) {
            const { state, descriptors, NavigationContent } = useNavigationBuilder(StackRouter, { children });
            return React.createElement(NavigationContent, null, descriptors[state.routes[state.index]!.key]!.render());
        }
        const Stack = createNavigatorFactory(Navigator)();
        const navigation = { push: (href: Parameters<typeof resolveHref>[0]) => {
            const url = new URL(resolveHref(href), 'https://app.happier.dev');
            native.dispatch(StackActions.push('callback', Object.fromEntries(url.searchParams)));
        }, replace() {}, back() {} };
        function Credentials() { return React.createElement(DestinationInstanceHost, {
            tabId: 'warm-callback', ref: { kind: 'settings', params: { pageId: 'connected-services' } },
            pathname: '/settings/connected-services', focused: true, visible: true, navigation,
            children: React.createElement(React.Fragment),
        }); }
        const projectNavigation = () => { browser.location = new URL(getPathFromState(native.getRootState(), config), 'https://app.happier.dev'); };
        const screen = await renderScreen(React.createElement(BaseNavigationContainer, { ref: native, onStateChange: projectNavigation,
            children: React.createElement(Stack.Navigator, { initialRouteName: 'credentials' },
                React.createElement(Stack.Screen, { name: 'credentials', component: Credentials }),
                React.createElement(Stack.Screen, { name: 'callback', component: Route })),
        }));
        const query = '?code=code&state=missing-attempt.nonce&iss=https%3A%2F%2Fissuer.example';
        try {
            await act(async () => { navigation.push(`${path}${query}`); });
            await vi.waitFor(async () => {
                await act(async () => {});
                const outcomes = ['paste', 'unfinished', 'invalid'].flatMap(kind => screen.findAllHostsByTestId(`${prefix}:${kind}`));
                expect(outcomes.length).toBeGreaterThan(0);
            });
            expect(screen.findAllHostsByTestId(`${prefix}:paste`).length).toBeGreaterThan(0);
            expect(screen.findAllHostsByTestId(`${prefix}:unfinished`)).toHaveLength(0);
            await screen.pressByTestIdAsync(`${prefix}:copy`);
            expect(copy).toHaveBeenCalledWith(`https://app.happier.dev${path}${query}`);
            expect(homes.requestsFor('/v2/connect/connected-account-attempt-transactions/missing-attempt'))
                .toEqual([expect.objectContaining({ serverId })]);
            expect(outgoing.filter(request => request.method.endsWith(CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD))).toEqual([]);
            await act(async () => { projectNavigation(); });
            expect((browser.location as URL).pathname + (browser.location as URL).search).toBe(path);
        } finally {
            await screen.unmount();
            callbackBoundary.active = false;
            for (const key of browserKeys) {
                const descriptor = previous[key];
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else delete browser[key];
            }
        }
    });
    it('approves live manual custody through the canonical human decision and sends the original private fields only to the daemon', async () => {
        const { runConnectedAccountAuthenticationAction } = await import('./connectedAccountDaemon');
        const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
        const { StoredApprovalRequestSchema } = await import('@happier-dev/protocol/approvals/approvalRequestV1');
        const { waitForHomeGovernance } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        const actionId = 'connectedServices.authentication.submitManual';
        await homes.requireUiApproval(serverId, actionId);
        const command = { operation: 'submitManual' as const, attemptId: 'attempt-1', fields: { token: 'private-live-token' } };
        const response = { status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'personal' } };
        homes.answer(serverId, '/v2/connect/connected-account-attempt-transactions/attempt-1', { body: {
            kind: 'manual', revision: 1, content: { t: 'plain', v: {} }, expiresAtMs: Date.now() + 60_000,
            scope: { machineId: 'machine-1', service, modeId: 'manual', intent: 'connect',
                phase: 'awaitingManual', createdAtMs: Date.now() },
        } });
        answers.push(response);
        const controller = new AbortController();
        const operation = runConnectedAccountAuthenticationAction({ serverId,
            expectedAccountId: 'account-a', command, signal: controller.signal });
        const outcome = operation.then(result => ({ result }), error => ({ error }));
        try {
            await waitForHomeGovernance(() => expect(homes.artifacts(serverId).list()).toHaveLength(1));
            const artifact = homes.artifacts(serverId).list()[0]!;
            const body = homes.artifacts(serverId).readPlainBody(artifact.id);
            const request = StoredApprovalRequestSchema.parse(JSON.parse(body ?? 'null'));
            expect(request).toMatchObject({ actionId, actionArgs: { attemptId: 'attempt-1' },
                executionOriginV1: { serverId, accountId: 'account-a' } });
            expect(request.actionArgs).not.toHaveProperty('machineId');
            expect(request.executionOriginV1).not.toHaveProperty('machineId');
            expect(body).not.toContain('private-live-token');
            expect(outgoing.filter(value => value.method === `machine-1:${CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD}`)).toEqual([]);
            await act(async () => {
                expect(await createDefaultActionExecutor().execute('approval.request.decide', { artifactId: artifact.id, decision: 'approve' },
                    { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: 'account-a' })).toMatchObject({ ok: true });
            });
            expect(await outcome).toMatchObject({ result: { ...response, requestId: expect.any(String) } });
            expect(outgoing).toContainEqual(expect.objectContaining({ method: `machine-1:${CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD}`,
                params: { v: 1, machineId: 'machine-1', command } }));
            expect(homes.artifacts(serverId).readPlainBody(artifact.id)).not.toContain('private-live-token');
        } finally { controller.abort(); await outcome; }
    });
    it('rejects an expected active-server basis that does not match the routed server', async () => {
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const expectedActiveServer = getActiveServerSnapshot();
        const otherHome = await homes.addHome({ name: 'Other Accounts Home', serverUrl: 'https://other-connected-accounts.test', accountId: 'account-b', active: false });
        const { runConnectedAccountAuthenticationCommand } = await import('./connectedAccountDaemon');
        await expect(runConnectedAccountAuthenticationCommand({
            serverId: otherHome, machineId: 'machine-1', expectedActiveServer, command: beginConnect,
        })).rejects.toMatchObject({ code: 'STALE_SERVER_GENERATION' });
        expect(outgoing).toEqual([]);
    });
    it('rechecks the active-server basis before exact machine-RPC issuance after network discovery', async () => {
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const expectedActiveServer = getActiveServerSnapshot();
        let release!: () => void;
        const held = new Promise<void>((resolve) => { release = resolve; });
        homes.answer(serverId, '/v1/machines/machine-1', { body: machineRow, respondAfter: held });
        const { runConnectedAccountAuthenticationCommand } = await import('./connectedAccountDaemon');
        const pending = runConnectedAccountAuthenticationCommand({ serverId, machineId: 'machine-1', expectedActiveServer, command: beginConnect });
        const rejected = expect(pending).rejects.toMatchObject({ code: 'STALE_SERVER_GENERATION' });
        try {
            await vi.waitFor(() => expect(homes.requestsFor('/v1/machines/read-batch')).toHaveLength(1));
            await homes.addHome({ name: 'New focused Home', serverUrl: 'https://new-connected-account-home.test', accountId: 'account-b' });
            // Change the captured selection while discovery is held; cold Account teardown
            // would instead retire the socket before its issuance guard can run.
            expect(getActiveServerSnapshot().generation).not.toBe(expectedActiveServer.generation);
        } finally { release(); }
        await rejected;
        expect(outgoing).toEqual([]);
    });
    it('sends only daemon-owned OAuth callback fields and rejects malformed responses', async () => {
        answers.push({ status: 'connected', attemptId: 'attempt-1', account: { service, accountId: 'account-1' } });
        const { runConnectedAccountAuthenticationCommand } = await import('./connectedAccountDaemon');
        const completion = { code: 'code-1', callbackUrl: 'http://127.0.0.1/callback', state: 'state-1' };
        await runConnectedAccountAuthenticationCommand({ serverId, machineId: 'machine-1',
            command: { operation: 'completeOAuth', attemptId: 'attempt-1', completion } });
        expect(outgoing[0]).toMatchObject({ params: { command: { operation: 'completeOAuth', completion } } });
        const payload = outgoing[0]?.params;
        if (!payload || typeof payload !== 'object' || !('command' in payload)) throw new Error('expected_authentication_wire');
        expect(payload.command).toMatchObject({ completion });
        expect(JSON.stringify(payload)).not.toContain('pkceVerifier');
        answers.push({ status: 'awaitingManual', attemptId: 'attempt-2', secret: 'must-not-pass' });
        await expect(runConnectedAccountAuthenticationCommand({ serverId, machineId: 'machine-1', command: { operation: 'read', attemptId: 'attempt-2' } })).rejects.toThrow();
    });
    it('preserves daemon unavailability as a typed response', async () => {
        answers.push({ status: 'unavailable', code: 'connected_account_daemon_runtime_unavailable' });
        const { runConnectedAccountAuthenticationCommand } = await import('./connectedAccountDaemon');
        await expect(runConnectedAccountAuthenticationCommand({ serverId, machineId: 'machine-1', command: beginConnect }))
            .resolves.toEqual({ status: 'unavailable', code: 'connected_account_daemon_runtime_unavailable' });
    });
    it.each([undefined, 'caller-request-id'])('retains the issued Action request identity on typed failure responses (%s)', async suppliedRequestId => {
        const attemptId = 'correlated-attempt';
        homes.answer(serverId, `/v2/connect/connected-account-attempt-transactions/${attemptId}`, { body: {
            kind: 'manual', revision: 1, content: { t: 'plain', v: {} }, expiresAtMs: Date.now() + 60_000,
            scope: { machineId: 'machine-1', service, modeId: 'manual', intent: 'connect',
                phase: 'awaitingManual', createdAtMs: Date.now() },
        } });
        answers.push({ status: 'unavailable', code: 'connected_account_daemon_response_invalid' });
        const { runConnectedAccountAuthenticationAction } = await import('./connectedAccountDaemon');
        const response = await runConnectedAccountAuthenticationAction({ serverId, expectedAccountId: 'account-a',
            command: { operation: 'read', attemptId },
            ...(suppliedRequestId ? { requestId: suppliedRequestId } : {}),
        });
        const issued = outgoing.find(request => request.method === `machine-1:${CONNECTED_ACCOUNT_AUTHENTICATION_COMMAND_RPC_METHOD}`);
        expect(issued?.requestId).toEqual(suppliedRequestId ?? expect.any(String));
        expect(response).toMatchObject({ status: 'unavailable', code: 'connected_account_daemon_response_invalid',
            requestId: issued?.requestId });
    });
    it('retains the issued pending discovery request identity on typed failure responses', async () => {
        answers.push({ status: 'unavailable', code: 'connected_account_daemon_response_invalid' });
        const { listPendingConnectedAccountAuthenticationActions } = await import('./connectedAccountDaemon');
        const response = await listPendingConnectedAccountAuthenticationActions({ serverId, machineId: 'machine-1',
            expectedAccountId: 'account-a', service });
        const issued = outgoing.find(request => request.method === `machine-1:${CONNECTED_ACCOUNT_CONTROL_COMMAND_RPC_METHOD}`);
        expect(issued?.requestId).toEqual(expect.any(String));
        expect(response).toMatchObject({ status: 'unavailable', code: 'connected_account_daemon_response_invalid',
            requestId: issued?.requestId });
    });
    it('retains the decoded transport cause when pending discovery fails at the real Action entry', async () => {
        const failureCause = { phase: 'connected_account.authentication', errorClass: 'Error', errorCode: 'ECONNREFUSED', httpStatus: null } as const;
        rpcFailures.push({ ok: false, error: 'Machine transport unavailable', errorCode: 'RPC_TRANSPORT_UNAVAILABLE', failureCause });
        const { listPendingConnectedAccountAuthenticationActions } = await import('./connectedAccountDaemon');
        await expect(listPendingConnectedAccountAuthenticationActions({ serverId, machineId: 'machine-1',
            expectedAccountId: 'account-a', service })).rejects.toMatchObject({
            code: 'RPC_TRANSPORT_UNAVAILABLE', failureCause, requestId: expect.any(String),
        });
    });
    it('routes strict descriptor/config control through the same exact owner', async () => {
        const described = {
            status: 'described', service,
            descriptor: { id: 'work', title: 'Acme Work', authentication: { defaultModeId: 'manual', modes: [{
                id: 'manual', kind: 'manual', outcomeReconciliation: 'none',
                fields: [{ id: 'token', title: 'Token', schema: { type: 'string', minLength: 1 }, secret: true }],
            }] } },
            occurrenceId: 'occurrence-1', sourceCustody: { kind: 'managed', immutableGenerationId: 'artifact-1', installSource: 'archive' },
            accounts: [],
        } satisfies ConnectedAccountDaemonControlResponse;
        answers.push(described);
        const { runConnectedAccountControlCommand, ConnectedAccountDaemonControlResponseSchema } = await import('./connectedAccountDaemon');
        await expect(runConnectedAccountControlCommand({ serverId, machineId: 'machine-1', command: { operation: 'describeService', service } })).resolves.toEqual(described);
        expect(outgoing.at(-1)).toMatchObject({ method: 'machine-1:daemon.connectedAccounts.control.command',
            params: { v: 1, machineId: 'machine-1', command: { operation: 'describeService', service } } });
        expect(ConnectedAccountDaemonControlResponseSchema.safeParse({ ...described, generation: 'removed-generation' }).success).toBe(false);
        answers.push({ status: 'unavailable', code: 'connected_account_configuration_target_unavailable', secretRefs: { token: 'must-not-pass' } });
        await expect(runConnectedAccountControlCommand({ serverId, machineId: 'machine-1', command: {
            operation: 'readConfiguration', target: { kind: 'account', account: { service, accountId: 'account-1' } },
        } })).rejects.toThrow();
    });
    it('routes exact-account revoke through the daemon and accepts only strict settlement responses', async () => {
        const account = { service: { pluginId: 'happier.scm.forge.github', localId: 'github-account' }, accountId: 'work' };
        answers.push({ status: 'revoked', account, remoteStatus: 'remoteUnsupported' });
        const { runConnectedAccountControlCommand } = await import('./connectedAccountDaemon');
        await expect(runConnectedAccountControlCommand({ serverId, machineId: 'machine-1',
            command: { operation: 'revokeAccount', account, cleanupGroupReferences: false } }))
            .resolves.toEqual({ status: 'revoked', account, remoteStatus: 'remoteUnsupported' });
        expect(outgoing.at(-1)).toMatchObject({ params: { command: { operation: 'revokeAccount', account, cleanupGroupReferences: false } } });
        answers.push({ status: 'outcomeUnknown', account, diagnostic: 'must-not-pass' });
        await expect(runConnectedAccountControlCommand({ serverId, machineId: 'machine-1',
            command: { operation: 'revokeAccount', account, cleanupGroupReferences: true } })).rejects.toThrow();
    });
});
