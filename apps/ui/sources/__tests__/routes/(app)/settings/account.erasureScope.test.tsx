import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTHORING_MEMORY_ROUTE_V1, AuthoringMemoryListResponseV1Schema } from '@happier-dev/protocol/account/authoringMemory';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { PROJECT_ACCOUNT_ROWS_ROUTE_V1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployments/testing/v1';
import { AccountErasureDeploymentBlockerV1Schema, type AccountErasureDeploymentBlockerV1 } from '@happier-dev/protocol/home/governance';
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
    vi.spyOn(text, 't').mockImplementation((key, ...params: unknown[]) => {
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
// #209's account-managed.log identifies the 409 and reason. The exact IDs are
// in erasure-peer/worker-{env,link-confirm}.json; the route adds the target kind.
const workerBlocker = {
    reason: 'provider_resource',
    environmentId: 'cmwu92tyb0297yjmcs3grroci',
    targetLinkId: 'cmwu942xi02a4yjmc1af2y42l',
    targetKind: 'cloudflare-workers',
} as const;
const projectSourceId = 'cmwu92l6r028yyjmcojzgak61';
const environmentName = 'QA 209 Worker Upload';
const workerName = 'qa-sweep-209-172-erase-worker';
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
    const targetLink = createDeploymentTargetLinkHeaderV1({ id: workerBlocker.targetLinkId, environmentId: environment.id,
        targetKind: workerBlocker.targetKind, machines: [], members: [],
        source: { kind: 'plugin', contribution: { pluginId: 'happier.deploy.cloudflare', localId: 'workers' } },
    });
    const artifacts = homeHttp.artifacts(homeId);
    artifacts.replaceStoredRow(createPlainArtifactHttpFixture({
        id: environment.contentArtifactId, isDecrypted: true, title: environmentName,
        header: { kind: 'deployment-environment.v1', title: environmentName }, body: '',
        headerVersion: environment.contentHeaderVersion, bodyVersion: environment.contentBodyVersion, seq: 1, createdAt: 1, updatedAt: 1,
    }, accountId));
    artifacts.replaceStoredRow(createPlainArtifactHttpFixture({
        id: targetLink.contentArtifactId, isDecrypted: true, title: 'Linked runtime',
        header: { kind: 'deployment-target-link.v1', title: 'Linked runtime' },
        body: JSON.stringify({ preparedNative: { projectName: workerName } }),
        headerVersion: targetLink.contentHeaderVersion, bodyVersion: targetLink.contentBodyVersion, seq: 2, createdAt: 1, updatedAt: 1,
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
        body: { ok: true, environment, targetLinks: [targetLink] },
    });
    homeHttp.answer(homeId, 'GET /v1/deployments/environments', { select: (_raw, request) => {
        const ids = new URL(request.url).searchParams.getAll('environmentIds');
        return { body: { ok: true, items: ids.includes(environment.id) ? [environment] : [], nextCursor: null } };
    } });
    await runtime.setActiveServer({ serverId: homeId, scope: 'device' });
    const connection = await import('@/sync/runtime/orchestration/connectionManager');
    await connection.switchConnectionToActiveServer();
    const { storage } = await import('@/sync/domains/state/storage');
    storage.getState().activateProfileScope({ serverId: profiles.resolveServerProfileScopeIdForIdentifier(homeId), accountId });
    const installed = blocker?.reason === 'provider_resource' ? await (async () => {
        const { manifest, activateAccount } = await import('../../../../../../../packages/plugins/deploy-cloudflare/src/index');
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const { installPortableAccountPluginReleaseForTest } = await import('@/dev/testkit/harness/portableAccountPlugin');
        const accountLifetime = captureActiveServerAccountScopeLifetime();
        if (!accountLifetime) throw new Error('Expected the Plain Account plugin scope');
        return installPortableAccountPluginReleaseForTest({ manifest, activate: activateAccount, accountLifetime, publishProjection: true });
    })() : undefined;
    const { router } = await import('expo-router');
    const push = vi.spyOn(router, 'push').mockClear();
    const { AuthProvider } = await import('@/auth/context/AuthContext');
    const { default: AccountScreen } = await import('@/app/(app)/settings/account');
    const screen = await renderScreen(<AuthProvider initialCredentials={credentials}>
        <ModalProvider><AccountScreen /></ModalProvider>
    </AuthProvider>);
    return { screen, homeId, push, installed, erasures: () => homeHttp.requestsFor('/v1/auth/account/delete'),
        preflights: () => homeHttp.requestsFor('/v1/auth/account/delete/preview') };
}

describe('Delete account deployment recovery dialog', () => {
    it('keeps deletion unavailable until retry reads the shared Environments', async () => {
        const { screen, homeId, erasures, preflights } = await mountErasureRefusal(null, true);
        const preview = 'GET /v1/auth/account/delete/preview';
        const retry = 'actions.confirmation-review.retry-review';
        const confirm = 'actions.confirmation-review.decision-approve';
        try {
            homeHttp.answer(homeId, preview, { status: 404, body: { error: 'not_found' } });
            await act(async () => { screen.pressByTestId('settings-account-delete'); });
            await vi.waitFor(() => expect(screen.findByTestId(retry), screen.getTextContent()).not.toBeNull());
            expect(screen.getTextContent()).toContain('Could not check what will be deleted');
            expect(screen.getTextContent()).toContain('Could not check which shared Environments would be deleted');
            expect(screen.findByTestId(confirmationInput)).toBeNull();
            expect(screen.findByTestId(confirm)).toBeNull();
            expect(erasures()).toHaveLength(0);

            await act(async () => { screen.pressByTestId(retry); });
            await vi.waitFor(() => expect(preflights()).toHaveLength(2));
            expect(screen.findByTestId(confirm)).toBeNull();
            expect(erasures()).toHaveLength(0);

            homeHttp.answer(homeId, preview, {
                body: { sharedEnvironments: sharedEnvironments.map(({ name: _name, ...row }) => row) },
            });
            await act(async () => { screen.pressByTestId(retry); });
            await vi.waitFor(() => expect(screen.findByTestId(confirmationInput), screen.getTextContent()).not.toBeNull());
            expect(screen.findByTestId(retry)).toBeNull();
            expect(screen.getTextContent()).toContain('Shared Staging');
            expect(screen.getTextContent()).toContain('3 other members will lose access');
            expect(preflights()).toHaveLength(3);
            expect(erasures()).toHaveLength(0);
            await act(async () => {
                screen.changeTextByTestId(confirmationInput, 'DELETE');
            });
            await act(async () => { screen.pressByTestId(confirm); });
            await vi.waitFor(() => expect(erasures()).toHaveLength(1));
        } finally { await screen.unmount(); }
    });

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

    const detachRoute = `deploymentDetachTarget=${workerBlocker.targetLinkId}`;
    const casesByReason: Record<AccountErasureDeploymentBlockerV1['reason'], {
        references: Omit<AccountErasureDeploymentBlockerV1, 'reason'>; message: string; route?: string;
    }> = {
        provider_resource: { references: workerBlocker, message: 'Happier still manages this target', route: detachRoute },
        teardown_incomplete: { references: workerBlocker, message: 'teardown did not finish', route: detachRoute },
        running_work: { references: { environmentId: workerBlocker.environmentId, deploymentId: 'running-receipt' },
            message: 'Wait for the deployment work to finish', route: 'deployment=running-receipt' },
        source_sharing: { references: { projectSourceId }, message: 'resolve the deployment Source’s shared ownership' },
        environment_dependencies: { references: { environmentId: workerBlocker.environmentId }, message: 'resolve its remaining dependency' },
        content_sharing: { references: { artifactId: 'shared-artifact' }, message: 'Withdraw sharing on the deployment Artifact' },
        graph_dependencies: { references: { environmentId: workerBlocker.environmentId }, message: 'resolve the deployment references' },
        foreign_automation: { references: { environmentId: workerBlocker.environmentId }, message: 'Ask the Automation’s owner to delete the Automation' },
    };
    const cases = [...AccountErasureDeploymentBlockerV1Schema.shape.reason.options.map(reason => {
        const { references, ...expected } = casesByReason[reason];
        return { ...expected, blocker: { ...references, reason } };
    }), { blocker: null, message: 'Could not identify which deployment is blocking deletion' }];

    it.each(cases)('renders the Home’s refusal and recovery (%j)', async ({ blocker, message, ...testCase }) => {
        const { screen, homeId, push, installed, erasures } = await mountErasureRefusal(blocker);
        try {
            await act(async () => { screen.pressByTestId('settings-account-delete'); });
            await vi.waitFor(() => expect(screen.findByTestId(confirmationInput), screen.getTextContent()).not.toBeNull());
            await act(async () => { screen.changeTextByTestId(confirmationInput, 'DELETE'); });
            await act(async () => { screen.pressByTestId('actions.confirmation-review.decision-approve'); });
            await vi.waitFor(() => expect(erasures()).toMatchObject([{ method: 'POST', input: { confirmation: 'DELETE' } }]));
            await vi.waitFor(() => expect(screen.getTextContent()).toContain(message));
            if (blocker?.environmentId) expect(screen.getTextContent()).toContain(environmentName);
            if (blocker?.reason === 'provider_resource') {
                expect(screen.getTextContent()).toContain(`${workerName} runs on Cloudflare Workers`);
            }
            expect(screen.getTextContent()).not.toContain('Ask a Home administrator');
            if ('route' in testCase && testCase.route) {
                expect(screen.getTextContent()).toContain(blocker?.reason === 'running_work' ? 'View deployment' : 'Detach and keep running');
                await screen.pressByTestIdAsync('web-modal-button-0');
                await vi.waitFor(() => expect(push).toHaveBeenCalledWith(expect.stringContaining(`/deployments/${projectSourceId}?serverId=${homeId}`)));
                expect(push).toHaveBeenCalledWith(expect.stringContaining(testCase.route));
            }
            expect(erasures()).toHaveLength(1);
        } finally {
            await screen.unmount();
            await installed?.dispose();
        }
    });
});
