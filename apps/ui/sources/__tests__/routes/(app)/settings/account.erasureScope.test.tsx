import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import type { AccountErasureDeploymentBlockerV1 } from '@happier-dev/protocol/home/governance';
import { installApprovalCommonModuleMocks } from '@/components/approvals/approvalsTestHelpers';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { installBrowserRuntimeForTests } from '@/dev/testkit/harness/browserRuntimeHarness';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries,
    waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createPlainArtifactHttpFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { installReactDomPortalBoundaryForTests } from '@/dev/testkit/mocks/reactDom';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { initializeTerminalRouteRuntimeForTests } from '../terminal/terminalRouteTestHelpers';

installTokenStorageWebPlatformMocks();
installApprovalCommonModuleMocks({
    modal: async () => vi.importActual('@/modal'),
});
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-camera', () => ({
    useCameraPermissions: () => [{ granted: true }, async () => ({ granted: true })],
    CameraView: { isModernBarcodeScannerAvailable: false, onModernBarcodeScanned: () => ({ remove() {} }), launchScanner() {}, async dismissScanner() {} },
}));
const browser = await installBrowserRuntimeForTests({ url: 'https://origin.example.test' });
await initializeTerminalRouteRuntimeForTests();
afterAll(() => browser.restore());

beforeEach(async () => {
    const text = await import('@/text');
    const { en } = await import('@/text/translations/homeGovernanceTranslations.shared');
    const { readRecord } = await import('@happier-dev/protocol/inputs/inputRecords');
    vi.spyOn(text, 't').mockImplementation((key, ...params) => {
        if (!key.startsWith('homeGovernance.')) return key;
        const value = key.split('.').slice(1).reduce<unknown>((row, segment) => readRecord(row)[segment], en);
        if (typeof value === 'function') return value(params[0]);
        return typeof value === 'string' ? value : key;
    });
});
const { ModalProvider } = await import('@/modal');
const homeHttp = createHomeGovernanceHarness();
const confirmationInput = 'actions.confirmation-review.typed-confirmation';

function activateBrowser() {
    browser.activate();
    browser.window.sessionStorage.clear();
    installReactDomPortalBoundaryForTests();
}

afterEach(async () => {
    await (await import('@/sync/runtime/orchestration/connectionManager')).disconnectActiveServerConnection();
    await homeHttp.reset();
    (await import('@/utils/system/runtimeFetch')).resetRuntimeFetch();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('Account erasure original confirmation target', () => {
    it('retains both Home credentials when focus changes inside the DELETE prompt', async () => {
        activateBrowser();
        const erasures: Array<{ home: string; authorization: string | null }> = [];
        const { setRuntimeFetch } = await import('@/utils/system/runtimeFetch');
        setRuntimeFetch(async (input, init) => {
            const url = new URL(String(input));
            if (!['https://prompt-a.example.test', 'https://prompt-b.example.test'].includes(url.origin)) throw new Error(`Unexpected Home: ${url.origin}`);
            if (url.pathname === '/v1/auth/account/delete/preview') return Response.json({ sharedEnvironments: [] });
            if (url.pathname === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: url.host.startsWith('prompt-a.') ? 'account-a' : 'account-b' }));
            if (url.pathname === '/v2/sessions' || url.pathname === '/v2/sessions/active') return Response.json({ sessions: [], hasNext: false, nextCursor: null });
            if (url.pathname === '/v1/auth/account/delete') {
                erasures.push({ home: url.origin, authorization: new Headers(init?.headers).get('Authorization') });
                return Response.json({ error: 'account_delete_failed' }, { status: 403 });
            }
            if (url.pathname === '/health' || url.pathname === '/v1/auth/ping') return Response.json({ ok: true });
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (url.pathname === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            if (url.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (url.pathname === AUTHORING_MEMORY_ROUTE_V1) return Response.json(AuthoringMemoryListResponseV1Schema.parse({ rows: [] }));
            if (url.pathname === `${PROJECT_ACCOUNT_ROWS_ROUTE_V1}/list`) return Response.json(createPlainProjectAccountRowListFixture());
            if (url.pathname === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: {
                encryption: { plaintextStorage: { enabled: true } }, e2ee: { keylessAccounts: { enabled: true } },
            } }));
            return new Response('{}', { status: 404 });
        });
        const profiles = await import('@/sync/domains/server/serverProfiles');
        const runtime = await import('@/sync/domains/server/serverRuntime');
        profiles.resetServerProfilesRuntimeForTests();
        const homeA = await profiles.upsertServerProfile({ serverUrl: 'https://prompt-a.example.test', name: 'Prompt A' });
        const homeB = await profiles.upsertServerProfile({ serverUrl: 'https://prompt-b.example.test', name: 'Prompt B' });
        const original = { token: createAccountTokenForTests('account-a', { currentAccount: true }) };
        const other = { token: createAccountTokenForTests('account-b', { currentAccount: true }) };
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        await expect(TokenStorage.setCredentialsForServerUrl(homeA.serverUrl, { serverId: homeA.id }, original)).resolves.toBe(true);
        await expect(TokenStorage.setCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id }, other)).resolves.toBe(true);
        await runtime.setActiveServer({ serverId: homeA.id, scope: 'device' });
        const connection = await import('@/sync/runtime/orchestration/connectionManager');
        await connection.switchConnectionToActiveServer();
        const { storage } = await import('@/sync/domains/state/storage');
        storage.getState().activateProfileScope({ serverId: profiles.resolveServerProfileScopeIdForIdentifier(homeA.id), accountId: 'account-a' });
        const { AuthProvider, getCurrentAuth } = await import('@/auth/context/AuthContext');
        const { default: AccountScreen } = await import('@/app/(app)/settings/account');
        const screen = await renderScreen(<AuthProvider initialCredentials={original}>
            <ModalProvider><AccountScreen /></ModalProvider>
        </AuthProvider>);
        try {
            const auth = getCurrentAuth();
            if (!auth) throw new Error('Expected the real original Home Auth provider');
            expect(auth.credentials).toEqual(original);
            const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
            expect(captureActiveServerAccountScopeLifetime()?.scope.accountId).toBe('account-a');
            await act(async () => { screen.pressByTestId('settings-account-delete'); });
            await waitForHomeGovernance(() => expect(screen.findByTestId(confirmationInput), screen.getTextContent()).not.toBeNull());
            await act(async () => {
                await runtime.setActiveServer({ serverId: homeB.id, scope: 'device' });
                expect(runtime.getActiveServerSnapshot().serverUrl).toBe(homeB.serverUrl);
                await auth.refreshFromActiveServer();
                storage.getState().activateProfileScope({ serverId: profiles.resolveServerProfileScopeIdForIdentifier(homeB.id), accountId: 'account-b' });
            });
            await waitForHomeGovernance(() => expect(getCurrentAuth()?.credentials).toEqual(other));
            await waitForHomeGovernance(() => expect(screen.findByTestId(confirmationInput)).toBeNull());
            expect(erasures).toEqual([]);
            expect(await TokenStorage.getCredentialsForServerUrl(homeA.serverUrl, { serverId: homeA.id })).toEqual(original);
            expect(await TokenStorage.getCredentialsForServerUrl(homeB.serverUrl, { serverId: homeB.id })).toEqual(other);
            expect(getCurrentAuth()).toMatchObject({ isAuthenticated: true, credentials: other });
        } finally { await screen.unmount(); }
    });
});

const cleanupRequired = 'account_erasure_deployment_cleanup_required';
// #205 worker-managed-erase.jsonl contains the signed refusal body. The browser's
// worker-refusal-writes.json is empty and worker-erase-writes.json is request metadata only.
const workerBlocker = {
    reason: 'provider_resource',
    environmentId: 'cmws9z7k9011wramcga6sgqih',
    targetLinkId: 'cmwsa510f01ixramco2o0v5ai',
    targetKind: 'cloudflare-workers',
} as const;
const projectSourceId = 'cmws9z04w011cramck2gnrr67';
const environmentName = 'QA 204 Worker Upload';
const sharedEnvironments = [
    { environmentId: 'shared-staging', contentArtifactId: 'staging-content', contentHeaderVersion: 1, contentBodyVersion: 1,
        name: 'Shared Staging', memberCount: 1 },
    { environmentId: 'shared-production', contentArtifactId: 'production-content', contentHeaderVersion: 1, contentBodyVersion: 1,
        name: 'Shared Production', memberCount: 3 },
] as const;

async function mountErasureRefusal(blocker: AccountErasureDeploymentBlockerV1 | null, shared = false) {
    activateBrowser();
    await homeHttp.reset();
    installHomeGovernanceBoundaries(homeHttp);
    const profiles = await import('@/sync/domains/server/serverProfiles');
    const runtime = await import('@/sync/domains/server/serverRuntime');
    const serverUrl = 'https://erasure-refusal.example.test';
    const accountId = 'erasure-account';
    const homeId = await homeHttp.addHome({ serverUrl, name: 'Erasure Home', accountId, currentAccount: true });
    const credentials = { token: createAccountTokenForTests(accountId, { currentAccount: true }) };
    const environment = createDeploymentEnvironmentHeaderV1({
        id: workerBlocker.environmentId, serverId: homeId, projectSourceId, runtimeTargetLinkId: workerBlocker.targetLinkId,
    });
    const artifacts = homeHttp.artifacts(homeId);
    artifacts.replaceStoredRow(createPlainArtifactHttpFixture({
        id: environment.contentArtifactId, isDecrypted: true, title: environmentName,
        header: { kind: 'deployment-environment.v1', title: environmentName }, body: '',
        headerVersion: environment.contentHeaderVersion, bodyVersion: environment.contentBodyVersion, seq: 1, createdAt: 1, updatedAt: 1,
    }, accountId));
    for (const row of shared ? sharedEnvironments : []) {
        artifacts.replaceStoredRow(createPlainArtifactHttpFixture({
            id: row.contentArtifactId, isDecrypted: true, title: row.name,
            header: { kind: 'deployment-environment.v1', title: row.name }, body: '',
            headerVersion: row.contentHeaderVersion, bodyVersion: row.contentBodyVersion, seq: 1, createdAt: 1, updatedAt: 1,
        }, accountId));
    }
    homeHttp.answer(homeId, 'GET /v1/auth/account/delete/preview', { body: {
        sharedEnvironments: shared ? sharedEnvironments.map(({ name: _name, ...row }) => row) : [],
    } });
    homeHttp.answer(homeId, 'POST /v1/auth/account/delete', { status: 409,
        body: blocker ? { error: cleanupRequired, blocker } : { error: cleanupRequired },
    });
    homeHttp.answer(homeId, `/v1/deployments/environments/${environment.id}`, {
        body: { ok: true, environment, targetLinks: [] },
    });
    await runtime.setActiveServer({ serverId: homeId, scope: 'device' });
    const connection = await import('@/sync/runtime/orchestration/connectionManager');
    await connection.switchConnectionToActiveServer();
    const { storage } = await import('@/sync/domains/state/storage');
    storage.getState().activateProfileScope({ serverId: profiles.resolveServerProfileScopeIdForIdentifier(homeId), accountId });
    const { router } = await import('expo-router');
    const push = vi.spyOn(router, 'push').mockClear();
    const { AuthProvider } = await import('@/auth/context/AuthContext');
    const { default: AccountScreen } = await import('@/app/(app)/settings/account');
    const screen = await renderScreen(<AuthProvider initialCredentials={credentials}>
        <ModalProvider><AccountScreen /></ModalProvider>
    </AuthProvider>);
    return { screen, homeId, push, erasures: () => homeHttp.requestsFor('/v1/auth/account/delete'),
        preflights: () => homeHttp.requestsFor('/v1/auth/account/delete/preview') };
}

describe('Delete account deployment recovery dialog', () => {
    it.each([true, false])('discloses the effect on members before confirming (shared: %s)', async shared => {
        const { screen, erasures, preflights } = await mountErasureRefusal(null, shared);
        try {
            await act(async () => { screen.pressByTestId('settings-account-delete'); });
            await vi.waitFor(() => expect(screen.findByTestId(confirmationInput), screen.getTextContent()).not.toBeNull());
            const content = screen.getTextContent();
            if (shared) {
                expect(content).toContain('Shared Staging');
                expect(content).toContain('1 other member will lose access');
                expect(content).toContain('Shared Production');
                expect(content).toContain('3 other members will lose access');
            } else {
                expect(content).not.toContain('other member');
            }
            expect(preflights()).toMatchObject([{ method: 'GET' }]);
            expect(preflights()).toHaveLength(1);
            expect(erasures()).toHaveLength(0);
        } finally { await screen.unmount(); }
    });

    const cases = [
        { blocker: workerBlocker, message: 'Happier still manages this target', route: /deploymentDetachTarget=cmwsa510f01ixramco2o0v5ai/ },
        { blocker: { ...workerBlocker, reason: 'teardown_incomplete' }, message: 'teardown did not finish', route: /deploymentDetachTarget=cmwsa510f01ixramco2o0v5ai/ },
        { blocker: { reason: 'running_work', environmentId: workerBlocker.environmentId, deploymentId: 'running-receipt' },
            message: 'Wait for the deployment work to finish', route: /deployment=running-receipt/ },
        { blocker: { reason: 'source_sharing', projectSourceId }, message: 'resolve the deployment Source’s shared ownership' },
        { blocker: { reason: 'environment_dependencies', environmentId: workerBlocker.environmentId }, message: 'identify the Environment dependency' },
        { blocker: { reason: 'content_sharing', artifactId: 'shared-artifact' }, message: 'Withdraw sharing on the deployment Artifact' },
        { blocker: { reason: 'graph_dependencies', environmentId: workerBlocker.environmentId }, message: 'resolve the deployment references' },
        { blocker: { reason: 'foreign_automation', environmentId: workerBlocker.environmentId }, message: 'Ask the Automation’s owner to delete the Automation' },
        { blocker: null, message: 'Ask a Home administrator to identify the deployment blocker' },
    ] as const;

    it.each(cases)('renders the Home’s refusal and recovery (%j)', async ({ blocker, message, ...testCase }) => {
        const { screen, homeId, push, erasures } = await mountErasureRefusal(blocker);
        try {
            await act(async () => { screen.pressByTestId('settings-account-delete'); });
            await vi.waitFor(() => expect(screen.findByTestId(confirmationInput), screen.getTextContent()).not.toBeNull());
            await act(async () => { screen.changeTextByTestId(confirmationInput, 'DELETE'); });
            await act(async () => { screen.pressByTestId('actions.confirmation-review.decision-approve'); });
            await vi.waitFor(() => expect(erasures()).toMatchObject([{ method: 'POST', input: { confirmation: 'DELETE' } }]));
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(message));
            if (blocker && 'environmentId' in blocker) expect(screen.getTextContent()).toContain(environmentName);
            if (blocker) expect(screen.getTextContent()).not.toContain('identify the deployment blocker');
            if ('route' in testCase) {
                expect(screen.getTextContent()).toContain(blocker?.reason === 'running_work' ? 'View deployment' : 'Detach and keep running');
                await screen.pressByTestIdAsync('web-modal-button-0');
                await vi.waitFor(() => expect(push).toHaveBeenCalledWith(expect.stringContaining(`/deployments/${projectSourceId}?serverId=${homeId}`)));
                expect(push).toHaveBeenCalledWith(expect.stringMatching(testCase.route));
            }
            expect(erasures()).toHaveLength(1);
        } finally { await screen.unmount(); }
    });
});
