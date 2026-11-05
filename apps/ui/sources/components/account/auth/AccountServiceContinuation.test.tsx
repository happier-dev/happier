import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen as renderFixtureScreen } from '@/dev/testkit';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createDesktopSecureStorageBoundary } from '@/dev/testkit/mocks/desktopSecureStorage';
import * as enrolledHomeOpening from '@/auth/pairing/openEnrolledHome';
import { AuthProvider } from '@/auth/context/AuthContext';
import { useAuth } from '@/auth/context/AuthContext';
import { initializeTerminalRouteRuntimeForTests } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { createDirectoryHttpFixture } from '@/sync/ops/accountDirectory/accountDirectoryTestFixtures';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import {
    adoptHomeProfile,
    listServerProfiles,
    removeServerProfile,
    resolveSelectedAccountServiceEndpoint,
    resolveServerProfileScopeId,
    setAccountServiceEndpoint,
    setActiveServerId,
    subscribeActiveServer,
} from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { AccountDirectorySession } from '@/sync/domains/accountDirectory/accountDirectorySession';
import { completeAccountServicePostAuth, type AccountPostAuthResult } from '@/sync/ops/accountDirectory/completeAccountServicePostAuth';
import { cancelPendingDirectoryHomeEnrollment, getPendingDirectoryHomeEnrollment } from '@/sync/ops/accountDirectory/enrollDirectoryHome';
import { ENROLLMENT_POLL_IDLE_DELAY_MS } from '@/auth/enrollment/enrollmentPollingBackoff';

installTokenStorageWebPlatformMocks();
// Hoist the web platform before static Auth/credential imports can capture a native shim instance.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
const boundary = vi.hoisted(() => ({ request: vi.fn<(endpoint: string, path: string, init?: RequestInit) => Promise<Response>>(
    async () => new Response('{}', { status: 404 }),
) }));
vi.mock('@/utils/system/runtimeFetch', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/system/runtimeFetch')>(),
    runtimeFetch: (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        return boundary.request(url.origin, `${url.pathname}${url.search}`, init);
    },
}));
const routerHarness = vi.hoisted(() => ({ replace: null as null | ReturnType<typeof vi.fn> }));
vi.mock('expo-router', async () => {
    const router = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock();
    routerHarness.replace = router.spies.replace;
    return router.module;
});

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/modal')>(),
    ...(await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
}));
import { Modal } from '@/modal';

await initializeTerminalRouteRuntimeForTests();
const { disconnectActiveServerConnection } = await import('@/sync/runtime/orchestration/connectionManager');
// The terminal route helper also hoists its router boundary. Install this
// screen's observer after that initialization, before importing the screen.
vi.doMock('expo-router', async () => {
    const router = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock();
    routerHarness.replace = router.spies.replace;
    return router.module;
});
// The terminal helper hoists a key-only route mock. Withdraw that boundary
// before importing this copy-bearing continuation and use the real text owner.
vi.doUnmock('@/text');
await (await import('@/text')).preloadTranslations('en');
const { AccountServiceContinuation } = await import('./AccountServiceContinuation');
const { HomesJourneysSpecimen } = await import('@/components/dev/homesJourneys/HomesJourneysSpecimen');
const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
const { AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider');
const { MainAppTabStateProvider } = await import('@/components/navigation/mobile/chrome/MainAppTabStateProvider');
const { CurrentUiContextProvider, useOptionalCurrentUiContextReader, usePublishCurrentUiContext } = await import('@/components/appShell/currentUiContext/CurrentUiContextProvider');
const { CurrentUiContextActionHost } = await import('@/components/appShell/currentUiContext/currentUiContextVoiceToolPort');
const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
const { createRootLayoutFeaturesResponse } = await import('@/dev/testkit/fixtures/featureFixtures');
const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
const { getAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { PluginSurfaceFocusEligibilityProvider } = await import('@/components/ui/presentation/PluginSurfaceFocusEligibility');
const { createArtifactStoreBoundary } = await import('@/dev/testkit/harness/artifactStoreBoundary');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { ActionApprovalRequestCreatedResultSchema } = await import('@happier-dev/protocol/actions/actionExecutionResult');
let currentReader: ReturnType<typeof useOptionalCurrentUiContextReader> = null;
let mountedAuthority: unknown;
function CurrentReaderProbe() {
    currentReader = useOptionalCurrentUiContextReader();
    const auth = useAuth();
    const execution = useMountedActionExecution(getActiveServerSnapshot().serverId);
    mountedAuthority = { authenticated: auth.isAuthenticated, kind: auth.credentialAuthorityKind,
        scope: execution.binding?.scope, ready: execution.ready };
    return null;
}
function renderScreen(children: React.ReactNode) {
    return renderFixtureScreen(<AuthProvider initialCredentials={null}>{children}</AuthProvider>);
}
let activateCurrent: ReturnType<typeof usePublishCurrentUiContext>['activateCurrent'] | undefined;
const focusEnrichment = { entity: { kind: 'account.home_continuation', label: 'Focused continuation' }, commands: [] };
function PublicationProbe() {
    activateCurrent = usePublishCurrentUiContext(focusEnrichment).activateCurrent;
    return null;
}

/** Non-secret binding to the Account credential a continuation was created under. */
const ACCOUNT_CREDENTIAL_TOKEN_DIGEST = 'C0jknAf55a-WIBFlxj8xId4cq00hoNQDzcbt4__9tlM';

let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
/** The visible label of the card action rendered under `testID`. */
function actionTitle(testID: string): string | undefined {
    return screen?.findAll((node) => node.props.testID === testID && typeof node.props.title === 'string')[0]?.props.title;
}

describe('exact invoking-surface continuation', () => {
    let fixture: ReturnType<typeof createDirectoryHttpFixture>;
    let browserRuntime: Awaited<ReturnType<typeof installBrowserRuntimeForTests>> | undefined;
    beforeEach(async () => {
        browserRuntime = await installBrowserRuntimeForTests({ url: 'https://app.happier.dev' });
        resetServerFeaturesClientForTests();
        fixture = createDirectoryHttpFixture();
        boundary.request.mockImplementation(fixture.request);
        setRuntimeFetch(async (input, init) => {
            const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
            return fixture.request(url.origin, `${url.pathname}${url.search}`, init);
        });
    });
    afterEach(async () => {
        await screen?.unmount();
        screen = undefined;
        await cancelPendingDirectoryHomeEnrollment();
        await disconnectActiveServerConnection();
        resetServerFeaturesClientForTests();
        browserRuntime?.restore();
        browserRuntime = undefined;
        vi.unstubAllGlobals();
        currentReader = null;
        activateCurrent = undefined;
    });

    it('refuses stale, cancelled, and ineligible explicit current-card activation', async () => {
        const tree = (eligible: boolean) => <AuthProvider initialCredentials={null}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider><CurrentReaderProbe />
                <PluginSurfaceFocusEligibilityProvider active currentUiContextActive={eligible}><PublicationProbe /></PluginSurfaceFocusEligibilityProvider>
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </AuthProvider>;
        screen = await renderFixtureScreen(tree(true));
        const retainedActivation = activateCurrent!;
        const cancelled = new AbortController();
        cancelled.abort();
        await expect(retainedActivation(cancelled.signal)).resolves.toBe(false);
        expect(currentReader?.readCurrentUiContext()?.entity?.label).toBe('Focused continuation');
        await screen.update(tree(false));
        await expect(retainedActivation()).resolves.toBe(false);
        expect(currentReader?.readCurrentUiContext()?.entity).toBeUndefined();
        await screen.unmount();
        screen = undefined;
        await expect(retainedActivation()).resolves.toBe(false);
    });

    it('publishes each dev-specimen Home continuation through the real current-card owner and retires the displaced command', async ({ onTestFinished }) => {
        const initialProfileIds = new Set(listServerProfiles().map((profile) => profile.id));
        const initialActiveProfile = listServerProfiles().find(
            (profile) => resolveServerProfileScopeId(profile) === getActiveServerSnapshot().serverId,
        ) ?? null;
        const initialAccountServiceEndpoint = resolveSelectedAccountServiceEndpoint();
        let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
        onTestFinished(async () => {
            await screen?.unmount();
            screen = undefined;
            await connection?.dispose();
            if (initialActiveProfile) await setActiveServerId(initialActiveProfile.id);
            for (const profile of listServerProfiles()) {
                if (!initialProfileIds.has(profile.id)) await removeServerProfile(profile.id);
            }
            if (initialAccountServiceEndpoint.url) await setAccountServiceEndpoint(initialAccountServiceEndpoint);
        });
        await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor,
            source: 'account-directory', descriptorAuthority: 'current_connection_observation', suggestedName: fixture.home.label });
        // An authenticated self-hosted Home does not require a selected Account Service. The
        // fresh test store intentionally keeps that selection absent.
        connection = await restoreServerAccountForTest({ serverUrl: 'https://home-a.test', accountId: 'alice',
            request: async (url) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/features') return Response.json({
                    ...createRootLayoutFeaturesResponse({ capabilities: {
                        serverIdentity: { serverIdentityId: 'srv_home_a' },
                    } }),
                    signInService: { v: 1, mode: 'disabled' },
                });
                if (path === '/v1/kv/bulk') return Response.json({ values: [] });
                return Response.json({}, { status: 404 });
            } });
        const credentials = connection.credentials;
        const request = async (url: RequestInfo | URL, init?: RequestInit) => {
            const parsed = new URL(String(url));
            if (parsed.origin === fixture.service.endpointUrl) {
                return await fixture.request(parsed.origin, `${parsed.pathname}${parsed.search}`, init);
            }
            if (parsed.pathname === '/v1/auth/ping') return Response.json({});
            if (parsed.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (parsed.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (parsed.pathname === '/v1/features') return Response.json({
                ...createRootLayoutFeaturesResponse({ capabilities: {
                    serverIdentity: { serverIdentityId: 'srv_home_a' },
                } }),
                signInService: { v: 1, mode: 'disabled' },
            });
            if (parsed.pathname === '/v1/kv/bulk') return Response.json({ values: [] });
            if (parsed.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            return Response.json({}, { status: 404 });
        };
        setRuntimeFetch(request);
        boundary.request.mockImplementation((endpoint, path, init) => request(`${endpoint}${path}`, init));
        const tree = (frame: string) => <AuthProvider initialCredentials={credentials}>
            <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider><CurrentUiContextActionHost />
                <CurrentReaderProbe /><HomesJourneysSpecimen only={frame} />
            </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
        </AuthProvider>;
        const cases = [
            ['continuation-choose', 'choose'],
            ['continuation-retry', 'retry'],
            ['continuation-refresh', 'refresh'],
            ['continuation-stop-waiting', 'stop_waiting'],
            ['continuation-relink', 'relink'],
            ['continuation-open', 'open'],
        ] as const;
        let retained: ReturnType<NonNullable<typeof currentReader>['resolveCurrentUiCommand']> = null;
        for (const [frame, operation] of cases) {
            if (!screen) screen = await renderFixtureScreen(tree(frame));
            else await screen.update(tree(frame));
            await vi.waitFor(async () => {
                await act(async () => {});
                const commands = currentReader?.readCurrentUiContext()?.commands ?? [];
                expect(commands.some(({ id }) => {
                    const command = currentReader?.resolveCurrentUiCommand(id)?.command;
                    return command?.kind === 'accountHomeContinuation' && command.operation === operation;
                }), JSON.stringify({ frame, operation, commands })).toBe(true);
            });
            if (retained) {
                expect(retained.retirementSignal.aborted).toBe(true);
                expect(currentReader?.resolveCurrentUiCommand(retained.id)).toBeNull();
            }
            const descriptor = currentReader?.readCurrentUiContext()?.commands.find(({ id }) => {
                const command = currentReader?.resolveCurrentUiCommand(id)?.command;
                return command?.kind === 'accountHomeContinuation' && command.operation === operation;
            });
            retained = descriptor ? currentReader?.resolveCurrentUiCommand(descriptor.id) ?? null : null;
            expect(retained?.command).toMatchObject({ kind: 'accountHomeContinuation', operation });
        }
    });

    it.each([
        { cancelOriginal: false, secondCard: false },
        { cancelOriginal: true, secondCard: false },
        { cancelOriginal: false, secondCard: true },
        { cancelOriginal: false, secondCard: false, requestApproval: true },
        { cancelOriginal: false, secondCard: false, requestApproval: true, revokeCredential: true },
        { cancelOriginal: false, secondCard: false, requestApproval: true, cancelDecision: true },
    ])('opens a Home from the actual authenticated mounted continuation despite its authorized focus change ($cancelOriginal cancellation, $secondCard second card, $requestApproval approval, $revokeCredential revocation, $cancelDecision decision cancellation)', async ({ cancelOriginal, secondCard, requestApproval, revokeCredential, cancelDecision }) => {
        // Only the credential-read race needs an asynchronous OS vault; the other cases remain browser flows.
        const vault = revokeCredential ? createDesktopSecureStorageBoundary() : null;
        let nativeReadGate: Promise<void> | null = null;
        let nativeReadStarted = false;
        let targetScopeId = '';
        if (vault) vi.stubGlobal('__TAURI_INTERNALS__', { invoke: async (command: string, args?: Record<string, unknown>) => {
            if (command === 'desktop_secure_storage_read' && nativeReadGate
                && getActiveServerSnapshot().serverId === targetScopeId) {
                nativeReadStarted = true;
                await nativeReadGate;
            }
            return vault.invoke(command, args);
        } });
        const target = await adoptHomeProfile({ descriptor: fixture.home.connectionDescriptor,
            source: 'account-directory', descriptorAuthority: 'current_connection_observation', suggestedName: fixture.home.label });
        targetScopeId = resolveServerProfileScopeId(target);
        await adoptHomeProfile({ descriptor: { serverUrl: 'https://home-a.test', homeServerIdentityId: 'home-a' }, source: 'manual' });
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://home-a.test', accountId: 'alice',
            request: async (url) => {
                const path = new URL(String(url)).pathname;
                if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
                if (path === '/v1/kv/bulk') return Response.json({ values: [] });
                return Response.json({}, { status: 404 });
            } });
        try {
        expect(await TokenStorage.setCredentialsForServerUrl(fixture.home.canonicalServerUrl,
            { serverId: target.id }, connection.credentials)).toBe(true);
        let rotatedVaultEntry: readonly [string, string] | undefined;
        if (vault) {
            const rotated = { ...connection.credentials, token: `${connection.credentials.token}-rotated` };
            const prepared = await TokenStorage.setCredentialsForServerUrlWithRollback('https://home-a.test',
                { serverId: connection.serverId }, rotated);
            if (!prepared) throw new Error('Expected the canonical credential writer to prepare replacement bytes');
            rotatedVaultEntry = [...vault.values.entries()].find(([, value]) => {
                try { return JSON.parse(value).token === rotated.token; } catch { return false; }
            });
            await prepared.rollback();
            expect(rotatedVaultEntry, JSON.stringify({
                vaultEntries: vault.values.size,
                host: (await import('@/utils/platform/desktopHost')).desktopHostKind(),
                platform: (await import('react-native')).Platform.OS,
            })).toBeDefined();
        }
        const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'alice', encryptionMode: 'plain' });
        const requestHome = async (url: RequestInfo | URL, init?: RequestInit) => {
            const requestUrl = new URL(String(url));
            const path = requestUrl.pathname;
            const artifactResponse = artifacts.handle(path, init);
            if (artifactResponse) return await artifactResponse;
            if (path === '/v1/auth/ping') return Response.json({});
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') {
                return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            }
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (path === '/v1/kv/bulk') return Response.json({ values: [] });
            if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            return Response.json({}, { status: 404 });
        };
        setRuntimeFetch(requestHome);
        boundary.request.mockImplementation((endpoint, path, init) => requestHome(`${endpoint}${path}`, init));
        const cancellation = new AbortController();
        const input = { service: fixture.service, credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST, signal: cancellation.signal,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        routerHarness.replace?.mockClear();
            screen = await renderFixtureScreen(<AuthProvider initialCredentials={connection.credentials}>
                <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider><CurrentUiContextActionHost />
                    <CurrentReaderProbe /><PluginSurfaceFocusEligibilityProvider active currentUiContextActive><AccountServiceContinuation input={input}
                        result={{ kind: 'home_enrolled', homeServerIdentityId: fixture.home.homeServerIdentityId }}
                        onResult={() => {}} onBack={() => {}} />
                        {secondCard ? <AccountServiceContinuation input={{ ...input }}
                            result={{ kind: 'home_enrolled', homeServerIdentityId: fixture.home.homeServerIdentityId }}
                            onResult={() => {}} onBack={() => {}} /> : null}
                    </PluginSurfaceFocusEligibilityProvider>
                </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
            </AuthProvider>);
            await vi.waitFor(async () => {
                await act(async () => {});
                const snapshot = currentReader?.readCurrentUiContext();
                expect(snapshot?.commands.some(command => command.title === 'Open Home B'), JSON.stringify({ snapshot, mountedAuthority })).toBe(true);
            });
            const descriptor = currentReader?.readCurrentUiContext()?.commands.find(command => command.title === 'Open Home B');
            const original = descriptor ? currentReader?.resolveCurrentUiCommand(descriptor.id) : null;
            const executor = createDefaultActionExecutor();
            const originServerId = getActiveServerSnapshot().serverId;
            let approvalId: string | undefined;
            let displacedApprovalId: string | undefined;
            if (requestApproval || secondCard) {
                const requested = await executor.execute('account.home_continuation.invoke', { operation: 'open', commandId: descriptor!.id }, {
                    surface: 'agent', serverId: originServerId, expectedAccountId: 'alice', actionRequestId: 'mounted-home-open-request',
                });
                expect(requested, JSON.stringify(requested)).toMatchObject({ ok: true });
                if (!requested.ok) throw new Error(requested.error);
                approvalId = ActionApprovalRequestCreatedResultSchema.parse(requested.result).artifactId;
                expect(JSON.parse(artifacts.readPlainBody(approvalId) ?? 'null')).toMatchObject({
                    status: 'open', actionId: 'account.home_continuation.invoke',
                    actionArgs: { operation: 'open', commandId: descriptor!.id }, executionOriginV1: { accountId: 'alice' },
                });
                expect(getActiveServerSnapshot().serverId).toBe(originServerId);
                expect(routerHarness.replace).not.toHaveBeenCalled();
                if (secondCard) { displacedApprovalId = approvalId; approvalId = undefined; }
            }
            let releaseFocus!: () => void;
            const focusRead = new Promise<void>(resolve => { releaseFocus = resolve; });
            nativeReadGate = vault ? focusRead : null;
            let decision: ReturnType<typeof executor.execute> | undefined;
            const decisionCancellation = new AbortController();
            let focusObserved = false;
            let focusReceiptStatus: unknown;
            const stopFocusObservation = subscribeActiveServer(snapshot => {
                if (snapshot.serverId !== targetScopeId || focusObserved) return;
                focusObserved = true;
                if (approvalId) focusReceiptStatus = JSON.parse(artifacts.readPlainBody(approvalId) ?? 'null')?.status;
                if (cancelOriginal) cancellation.abort();
                if (cancelDecision) decisionCancellation.abort();
            });
            try {
                if (approvalId) {
                    decision = executor.execute('approval.request.decide', { artifactId: approvalId, decision: 'approve' }, {
                        surface: 'ui', serverId: originServerId, expectedAccountId: 'alice', signal: decisionCancellation.signal,
                    });
                } else if (secondCard) {
                    const actions = screen.findAllHostsByTestId('account-service-continuation-home_enrolled-action');
                    await act(async () => { actions.at(-1)!.props.onPress(); });
                    expect(original?.retirementSignal.aborted).toBe(true);
                    expect(currentReader?.resolveCurrentUiCommand(original!.id)).toBeNull();
                } else await screen.pressByTestIdAsync('account-service-continuation-home_enrolled-action');
                await vi.waitFor(async () => {
                    await act(async () => {});
                    expect(focusObserved).toBe(true);
                    expect(original?.retirementSignal.aborted).toBe(true);
                });
                if (approvalId) expect(focusReceiptStatus).toBe('executing');
                if (revokeCredential) {
                    await vi.waitFor(() => expect(nativeReadStarted).toBe(true));
                    if (!vault || !rotatedVaultEntry) throw new Error('Expected the Desktop vault replacement fixture');
                    // Another OS-vault writer is not serialized behind this process's held migration read.
                    await vault.invoke('desktop_secure_storage_write', { key: rotatedVaultEntry[0], value: rotatedVaultEntry[1] });
                }
            } finally { releaseFocus(); nativeReadGate = null; stopFocusObservation(); }
            if (decision) {
                const settled = await decision;
                // OWNER-RULINGS 2026-10-29: finite admitted work finishes;
                // credential replacement applies at the next natural boundary.
                expect(settled, JSON.stringify(settled)).toMatchObject({ ok: true, result: { status: 'executed' } });
                expect(JSON.parse(artifacts.readPlainBody(approvalId!) ?? 'null')).toMatchObject({ status: 'executed' });
            }
            await vi.waitFor(async () => {
                await act(async () => {});
                expect(getActiveServerSnapshot().serverId).toBe(resolveServerProfileScopeId(target));
                if (cancelOriginal) expect(routerHarness.replace).not.toHaveBeenCalled();
                else expect(routerHarness.replace).toHaveBeenCalledWith('/');
            });
            if (displacedApprovalId) {
                expect(await executor.execute('approval.request.decide', { artifactId: displacedApprovalId, decision: 'approve' }, {
                    surface: 'ui', serverId: originServerId, expectedAccountId: 'alice',
                })).toMatchObject({ ok: true, result: { status: 'failed' } });
                expect(JSON.parse(artifacts.readPlainBody(displacedApprovalId) ?? 'null')).toMatchObject({ status: 'failed' });
                expect(routerHarness.replace).toHaveBeenCalledTimes(1);
            }
        } finally { await screen?.unmount(); screen = undefined; await connection.dispose(); }
    });

    it('requests exact service reauthentication rather than treating recovery as Back', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        let received: unknown;
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'failure', stage: 'refresh', code: { source: 'directory', code: 'invalid_token' }, recovery: 'reauthenticate_account', accountCredentialCommitted: true, homeCredentialCommitted: false }}
            onResult={() => {}} onBack={() => {}} onReauthenticate={(value) => { received = value; }} />);
        await screen.pressByTestIdAsync('account-service-continuation-failure-action');
        expect(received).toBe(input);
    });

    it('explains each typed continuation failure with its own copy instead of one enrollment body', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'failure', stage: 'enroll', code: { source: 'home', code: 'rejected' }, recovery: 'stop', accountCredentialCommitted: true, homeCredentialCommitted: false }}
            onResult={() => {}} onBack={() => {}} />);
        expect(screen.getTextContent()).toContain('A trusted device rejected this request');
        expect(screen.getTextContent()).not.toContain('Open Account settings to continue connecting the Home');
        await screen.unmount();

        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'failure', stage: 'refresh', code: { source: 'directory', code: 'account-disabled' }, recovery: 'stop', accountCredentialCommitted: true, homeCredentialCommitted: false }}
            onResult={() => {}} onBack={() => {}} />);
        expect(screen.getTextContent()).toContain('This account is disabled');
        expect(screen.getTextContent()).not.toContain('Open Account settings to continue connecting the Home');
    });

    // `stop` is what the directory projects for a declined approval; `retry_stage` must not demote it to Retry.
    it.each(['stop', 'retry_stage'] as const)('keeps a rejected approval on the fresh-attempt action (%s recovery)', async (recovery) => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'failure', stage: 'enroll', code: { source: 'home', code: 'rejected' }, recovery, accountCredentialCommitted: true, homeCredentialCommitted: false }}
            onResult={() => {}} onBack={() => {}} />);

        expect(screen.getTextContent()).toContain('Start again');
        expect(screen.getTextContent()).not.toContain('Retry');
    });

    it('presents a completed account connection as success rather than warning', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'refresh' as const } };
        const onBack = vi.fn();
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'account_connected' }} onResult={() => {}} onBack={onBack} />);

        expect(screen.findByTestId('account-service-continuation-account_connected-icon')
            ?.findByType('Icon').props.name).toBe('check-circle');
        expect(screen.getTextContent()).toContain('Signed in to https://directory.test');
        expect(screen.getTextContent()).toContain('Your focused Home won’t change.');
        expect(screen.getTextContent()).not.toContain('your Personal Home was not added');
        expect(screen.getTextContent()).not.toContain('Open Home');

        await screen.pressByTestIdAsync('account-service-continuation-account_connected-action');
        expect(onBack).toHaveBeenCalledOnce();
    });

    it('opens an enrolled Home through the canonical focus owner and lands on it', async ({ onTestFinished }) => {
        // Home focus uses the browser's complete tab storage and event boundary.
        browserRuntime!.reconfigureUrl('https://app.happier.dev');
        const profile = await adoptHomeProfile({
            descriptor: fixture.home.connectionDescriptor,
            source: 'account-directory',
            descriptorAuthority: 'current_connection_observation',
            suggestedName: fixture.home.label,
        });
        // home_enrolled is emitted after this exact Home's Account credential has been committed.
        expect(await TokenStorage.setCredentialsForServerUrl(fixture.home.canonicalServerUrl,
            { serverId: profile.id }, { token: fixture.token })).toBe(true);
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        const onBack = vi.fn();
        const openOwner = vi.spyOn(enrolledHomeOpening, 'openEnrolledHomeOrReturnToShell');
        onTestFinished(() => openOwner.mockRestore());
        routerHarness.replace?.mockClear();
        vi.mocked(Modal.alertAsync).mockClear();
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'home_enrolled', homeServerIdentityId: fixture.home.homeServerIdentityId }}
            onResult={() => {}} onBack={onBack} />);

        // Open is the card's primary; keeping the current focus is its quieter secondary.
        expect(actionTitle('account-service-continuation-home_enrolled-action')).toBe('Open Home B');
        expect(actionTitle('account-service-continuation-home_enrolled-secondary-action')).toBe('Back');
        await screen.pressByTestIdAsync('account-service-continuation-home_enrolled-action');
        await vi.waitFor(() => expect(openOwner).toHaveBeenCalledTimes(1));
        await act(async () => { expect(await openOwner.mock.results[0]!.value).toBe('opened'); });

        // The canonical owner focused the enrolled Home in this tab and landed on the shell.
        await vi.waitFor(() => expect(routerHarness.replace).toHaveBeenCalledWith('/'));
        expect(getActiveServerSnapshot().serverId).toBe(resolveServerProfileScopeId(profile));
        expect(Modal.alertAsync).not.toHaveBeenCalledWith(fixture.home.label, expect.anything(), expect.anything());
        expect(routerHarness.replace).toHaveBeenCalledWith('/');
        expect(onBack).not.toHaveBeenCalled();

        await screen.pressByTestIdAsync('account-service-continuation-home_enrolled-secondary-action');
        expect(onBack).toHaveBeenCalledOnce();
    });

    it('keeps the enrolled-Home card when the user declines to retry a failed open', async () => {
        const target = await adoptHomeProfile({
            descriptor: fixture.home.connectionDescriptor,
            source: 'account-directory',
            descriptorAuthority: 'current_connection_observation',
            suggestedName: fixture.home.label,
        });
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        const onBack = vi.fn();
        routerHarness.replace?.mockClear();
        vi.mocked(Modal.alertAsync).mockClear();
        const requestHome = async (url: RequestInfo | URL) => {
            const requestUrl = new URL(String(url));
            if (requestUrl.pathname === '/v1/auth/ping') return Response.json({});
            if (requestUrl.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (requestUrl.pathname === '/v1/account/encryption/currentness') {
                return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            }
            if (requestUrl.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse());
            if (requestUrl.pathname === '/v1/kv/bulk') return Response.json({ values: [] });
            if (requestUrl.pathname === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: {} }, version: 1 });
            return Response.json({}, { status: 404 });
        };
        const connection = await restoreServerAccountForTest({ serverUrl: 'https://failed-open-origin.test',
            accountId: 'alice', request: requestHome });
        expect(await TokenStorage.setCredentialsForServerUrl(fixture.home.canonicalServerUrl,
            { serverId: target.id }, connection.credentials)).toBe(true);
        setRuntimeFetch(requestHome);
        boundary.request.mockImplementation((endpoint, path) => requestHome(`${endpoint}${path}`));
        try {
            screen = await renderFixtureScreen(<AuthProvider initialCredentials={connection.credentials}>
                <MainAppTabStateProvider><AppPaneProvider><CurrentUiContextProvider><CurrentUiContextActionHost />
                    <CurrentReaderProbe /><PluginSurfaceFocusEligibilityProvider active currentUiContextActive>
                        <AccountServiceContinuation input={input}
                            result={{ kind: 'home_enrolled', homeServerIdentityId: fixture.home.homeServerIdentityId }}
                            onResult={() => {}} onBack={onBack} />
                    </PluginSurfaceFocusEligibilityProvider>
                </CurrentUiContextProvider></AppPaneProvider></MainAppTabStateProvider>
            </AuthProvider>);
            await vi.waitFor(() => expect(currentReader?.readCurrentUiContext()?.commands.some(({ id }) => {
                const command = currentReader?.resolveCurrentUiCommand(id)?.command;
                return command?.kind === 'accountHomeContinuation' && command.operation === 'open';
            })).toBe(true));
            // Fail only the browser's addressed tab-focus write. Credential reads
            // and current-card admission remain available on the invoking Home.
            vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
            const setItem = window.Storage.prototype.setItem;
            const storageWrite = vi.spyOn(window.Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
                if (key === 'activeServerId' && value === target.id) throw new Error('Tab focus storage unavailable');
                setItem.call(this, key, value);
            });
            const openOwner = vi.spyOn(enrolledHomeOpening, 'openEnrolledHomeOrReturnToShell');
            try {
                await screen.pressByTestIdAsync('account-service-continuation-home_enrolled-action');
                await vi.waitFor(() => expect(openOwner).toHaveBeenCalledOnce());
                expect(storageWrite).toHaveBeenCalledWith('activeServerId', target.id);
                const openOutcome = await openOwner.mock.results[0]!.value;
                expect(openOutcome, JSON.stringify({ selected: getActiveServerSnapshot().serverId,
                    applied: getAppliedActiveServerSnapshot().serverId,
                    origin: connection.serverId, target: target.id, navigation: routerHarness.replace?.mock.calls })).toBe('returned_to_shell');
                await vi.waitFor(() => expect(Modal.alertAsync).toHaveBeenCalledWith('Home B', expect.anything(), expect.anything()));
            }
            finally { openOwner.mockRestore(); storageWrite.mockRestore(); }
            expect(onBack).not.toHaveBeenCalled();
            expect(routerHarness.replace).not.toHaveBeenCalled();
            expect(actionTitle('account-service-continuation-home_enrolled-action')).toBe('Open Home B');
        } finally {
            await screen?.unmount();
            screen = undefined;
            await connection.dispose();
        }
    });

    it('stops offering Open when the enrolled Home has no saved profile to open', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: 'srv_unsaved_home' } };
        const onBack = vi.fn();
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'home_enrolled', homeServerIdentityId: 'srv_unsaved_home' }}
            onResult={() => {}} onBack={onBack} />);

        expect(actionTitle('account-service-continuation-home_enrolled-action')).toBe('Done');
        await screen.pressByTestIdAsync('account-service-continuation-home_enrolled-action');
        expect(onBack).toHaveBeenCalledOnce();
    });

    it('offers a Homeless account its refresh first and scanning second, with a body that names both', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enter' as const, target: { kind: 'automatic' as const } } };
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'account_connected_no_homes' }} onResult={() => {}} onBack={() => {}} />);

        expect(actionTitle('account-service-continuation-account_connected_no_homes-action')).toBe('Refresh');
        expect(actionTitle('account-service-continuation-account_connected_no_homes-secondary-action'))
            .toBe('Scan a QR or paste a Home link');
        expect(screen.getTextContent()).not.toContain('Open Account settings');
        // Refresh and scan are the card's own pair; no escape or bare button competes.
        expect(screen.getTextContent()).not.toContain('Back');
    });

    it('tells the waiting user what to do and confirms the sign-in survived stop-waiting', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        let backs = 0;
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'approval_required', homeServerIdentityId: fixture.home.homeServerIdentityId, expiresAtMs: Date.now() + 300_000 }}
            onResult={() => {}} onBack={() => { backs += 1; }} />);
        expect(screen.getTextContent()).toContain('Approve this sign-in from your other signed-in device');
        // The Home name and the expiry stay as the secondary line they already were.
        expect(screen.getTextContent()).toContain('·');

        await screen.pressByTestIdAsync('account-service-continuation-approval_required-action');
        expect(backs).toBe(0);
        expect(screen.getTextContent()).toContain('Stopped waiting for approval');
        expect(screen.getTextContent()).toContain('Your sign-in is still saved');

        await screen.pressByTestIdAsync('account-service-approval-stopped-action');
        expect(backs).toBe(1);
    });

    it('names each choosable Home by address and marks the preferred one', async () => {
        const { service } = fixture;
        const input = { service, session: new AccountDirectorySession({ endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { capability: service.capability }),
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            intent: { kind: 'enter' as const, target: { kind: 'automatic' as const } } };
        const other = { ...fixture.home, homeServerIdentityId: 'srv_other', label: 'Other Home', canonicalServerUrl: 'https://other.example.test', preferred: false };
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'choose_home', homes: [{ ...fixture.home, preferred: true }, other] }}
            onResult={() => {}} onBack={() => {}} />);
        const text = screen.getTextContent();
        expect(text).toContain(fixture.home.canonicalServerUrl);
        expect(text).toContain('https://other.example.test');
        expect(text).toContain('Preferred');
    });

    it('reports an unlinked Home as a status with direct sign-in first and scan-or-paste second', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enter' as const, target: { kind: 'explicit' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } } };
        const previous = { kind: 'explicit_target_not_linked' as const, homeServerIdentityId: fixture.home.homeServerIdentityId };
        const onOpenHomeAuthentication = vi.fn();
        screen = await renderScreen(<AccountServiceContinuation input={input} result={previous}
            onResult={() => {}} onBack={() => {}} onOpenHomeAuthentication={onOpenHomeAuthentication} />);

        // The sign-in succeeded; an unlinked Home is a state to act on, not a failure.
        const card = screen.findByTestId('account-service-continuation-explicit_target_not_linked');
        expect(card?.props.accessibilityLiveRegion).toBe('polite');
        expect(screen.getTextContent()).not.toContain('Connection failed');
        expect(screen.getTextContent()).toContain('isn’t linked to this account yet');
        // The body explains both ways forward in the order of the card's actions, without repeating the title.
        expect(screen.findByTestId('account-service-continuation-explicit_target_not_linked-reason')?.props.children)
            .toBe('Sign in to Home directly, or scan its QR code or paste its Home link.');
        expect(screen.getTextContent()).not.toContain('is not linked to your sign-in service on this device');
        expect(screen.getTextContent()).not.toContain('Signed in to');
        // One card, one primary: no escape-as-primary and no anonymous bare Continue below it.
        expect(screen.getTextContent()).not.toContain('Back');
        expect(screen.getTextContent()).not.toContain('Continue');
        expect(screen.findAllByTestId('account-service-direct-home-auth')).toHaveLength(0);

        await screen.pressByTestIdAsync('account-service-continuation-explicit_target_not_linked-action');
        expect(onOpenHomeAuthentication).toHaveBeenCalledWith(input, fixture.home.homeServerIdentityId, previous);
        expect(actionTitle('account-service-continuation-explicit_target_not_linked-secondary-action'))
            .toBe('Scan a QR or paste a Home link');
        await screen.unmount();

        screen = await renderScreen(<AccountServiceContinuation input={input} result={previous}
            onResult={() => {}} onBack={() => {}} />);
        // Without a direct Home sign-in host, scan-or-paste is the one way forward.
        expect(actionTitle('account-service-continuation-explicit_target_not_linked-action'))
            .toBe('Scan a QR or paste a Home link');
        expect(screen.findByTestId('account-service-continuation-explicit_target_not_linked-reason')?.props.children)
            .toBe('Scan the QR code of Home or paste its Home link to connect it.');
        expect(screen.findAllByTestId('account-service-continuation-explicit_target_not_linked-secondary-action')).toHaveLength(0);
    });

    it('leads a Home-auth recovery with signing in to that Home inside the card, scan second', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        const previous: AccountPostAuthResult = { kind: 'failure', stage: 'material', code: { source: 'local', code: 'account_mode_unavailable' },
            recovery: 'use_home_auth', accountCredentialCommitted: true, homeCredentialCommitted: false,
            targetHomeServerIdentityId: fixture.home.homeServerIdentityId };
        const onOpenHomeAuthentication = vi.fn();
        screen = await renderScreen(<AccountServiceContinuation input={input} result={previous}
            onResult={() => {}} onBack={() => {}} onOpenHomeAuthentication={onOpenHomeAuthentication} />);

        // One card, one primary: direct sign-in is the card's own action, never a heavier bare button beneath it.
        // No saved profile or directory entry names this Home, so the product noun stands in.
        expect(actionTitle('account-service-continuation-failure-action')).toBe('Sign in to Home');
        expect(actionTitle('account-service-continuation-failure-secondary-action')).toBe('Scan a QR or paste a Home link');
        expect(screen.findAllByTestId('account-service-direct-home-auth')).toHaveLength(0);
        expect(screen.findByTestId('account-service-continuation-failure-reason')?.props.children)
            .toBe('Sign in to Home directly, or scan its QR code or paste its Home link.');
        await screen.pressByTestIdAsync('account-service-continuation-failure-action');
        expect(onOpenHomeAuthentication).toHaveBeenCalledWith(input, fixture.home.homeServerIdentityId, previous);
    });

    it('offers scanning as the key form\'s own secondary choice when Home material is missing', async () => {
        const input = { service: fixture.service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: fixture.service.endpointUrl, serverIdentityId: fixture.service.serverIdentityId }, { capability: fixture.service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId } };
        screen = await renderScreen(<AccountServiceContinuation input={input}
            result={{ kind: 'home_material_required', homeServerIdentityId: fixture.home.homeServerIdentityId, homeAccountId: 'account-home', intent: input.intent, reason: 'missing_material' }}
            onResult={() => {}} onBack={() => {}} />);

        const scanButtons = screen.findAll((node) => node.props.title === 'Scan a QR or paste a Home link' && typeof node.props.testID === 'string');
        expect(scanButtons.map((node) => node.props.testID)).toEqual(['restore-manual-secondary']);
        expect(scanButtons[0]?.props.display).toBe('inverted');
    });

    it('admits only one Home choice while the shared coordinator is refreshing', async () => {
        const { service } = fixture;
        await TokenStorage.accountDirectoryAuthCredentials.set({ endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { token: 'directory-token' });
        const input = { service, session: new AccountDirectorySession({ endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { capability: service.capability }),
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            intent: { kind: 'enter' as const, target: { kind: 'automatic' as const } } };
        const other = { ...fixture.home, homeServerIdentityId: 'srv_other', label: 'Other Home' };
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        let homeReads = 0;
        boundary.request.mockImplementation(async (endpoint: string, path: string, init?: RequestInit) => {
            if (path === '/v1/account-directory/homes') { homeReads += 1; await gate; }
            return fixture.request(endpoint, path, init);
        });
        const outcomes: AccountPostAuthResult[] = [];
        screen = await renderScreen(<AccountServiceContinuation input={input} result={{ kind: 'choose_home', homes: [fixture.home, other] }} onResult={(result) => { outcomes.push(result); }} onBack={() => {}} />);
        let first!: Promise<void>;
        act(() => { first = screen!.findByTestId(`account-service-choose-home-${fixture.home.homeServerIdentityId}`)!.props.onPress(); });
        await vi.waitFor(() => expect(homeReads).toBe(1));
        let second!: Promise<void>;
        act(() => { second = screen!.findByTestId('account-service-choose-home-srv_other')!.props.onPress(); });
        try {
            await act(async () => { await Promise.resolve(); });
            expect(homeReads).toBe(1);
        } finally {
            await act(async () => { release(); await Promise.all([first, second]); });
        }
        expect(outcomes).toHaveLength(1);
    });

    it('resumes retained authority even when device service selection changes', async () => {
        const { service } = fixture;
        const controller = new AbortController();
        await TokenStorage.accountDirectoryAuthCredentials.set({ endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { token: 'directory-token' });
        const input = { service,
            credentialTokenDigest: ACCOUNT_CREDENTIAL_TOKEN_DIGEST,
            session: new AccountDirectorySession({ endpoint: service.endpointUrl, serverIdentityId: service.serverIdentityId }, { capability: service.capability }),
            intent: { kind: 'enroll' as const, homeServerIdentityId: fixture.home.homeServerIdentityId },
            signal: controller.signal,
        };
        const initial = await completeAccountServicePostAuth(input);
        expect(initial.kind).toBe('approval_required');
        controller.abort();
        let outcome: AccountPostAuthResult = initial;
        function Invoker() {
            const [result, setResult] = React.useState(initial);
            return <AccountServiceContinuation input={input} result={result} onResult={(next) => { outcome = next; setResult(next); }} onBack={() => {}} />;
        }
        screen = await renderScreen(<Invoker />);
        await setAccountServiceEndpoint({ url: 'https://unrelated.test', serverIdentityId: 'srv_unrelated', source: 'user' });
        fixture.state.approval = 'approved';
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, ENROLLMENT_POLL_IDLE_DELAY_MS + 100)); });
        await vi.waitFor(() => expect(outcome).toEqual({ kind: 'home_enrolled', homeServerIdentityId: fixture.home.homeServerIdentityId }));
        expect(getPendingDirectoryHomeEnrollment()).toBeNull();
        expect(fixture.state.calls.some(({ endpoint }) => endpoint === 'ambient' || endpoint === 'https://unrelated.test')).toBe(false);
        expect(fixture.state.calls.filter(({ path }) => path.includes('login-assertion'))).toHaveLength(1);
    });
});
