import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, type MachineInstallationIdentityV1 } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import type { SocketRpcRequestPayload } from '@happier-dev/protocol/socketRpc';
import { ApiClient } from '../../../../apps/cli/src/api/api';
import { createPlainSessionFixture } from '../../../../apps/cli/src/testkit/backends/sessionFixtures';
import { withTempDir } from '../../../../apps/cli/src/testkit/fs/tempDir';
import { createEnvKeyScope } from '../../../../apps/cli/src/testkit/env/envScope';
import { configuration, reloadConfiguration } from '../../../../apps/cli/src/configuration';
import { readOrCreateInstallationIdentity } from '../../../../apps/cli/src/daemon/identity/store';
import { ensureSessionMachineAccessKeyBinding } from '../../../../apps/cli/src/api/session/ensureSessionMachineAccessKeyBinding';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '../../../../apps/cli/src/api/client/serverHttpBaseUrl';

const socketIoBoundary = vi.hoisted(() => ({ created: 0, connected: 0,
    onSessionConnect: undefined as (() => void) | undefined }));

// Only persistent database I/O and the Session Socket.IO link are substituted.
// Home authorization, receipt production, HTTP currentness, installation proof,
// the actual SessionClient authorizer and its preview handler all stay real.
vi.mock('../../../../apps/server/sources/storage/db', async importOriginal => {
    const storagePath = '../../../../apps/server/sources/app/api/testkit/installedSessionExternalActionStorage';
    const storage = await import(storagePath) as { installedSessionExternalActionStorage: { db: unknown } };
    return { ...await importOriginal<Record<string, unknown>>(), db: storage.installedSessionExternalActionStorage.db };
});
vi.mock('socket.io-client', async () => {
    const { createApiSessionSocketStub } = await import('../../../../apps/cli/src/testkit/backends/apiSessionSocketHarness');
    return { io: (_endpoint: string, options: { auth?: { clientType?: string } }) => {
        socketIoBoundary.created++;
        return createApiSessionSocketStub({ connected: false, onConnect: () => {
            socketIoBoundary.connected++;
            if (options.auth?.clientType === 'session-scoped') socketIoBoundary.onSessionConnect?.();
        } });
    } };
});

beforeAll(async () => {
    vi.stubEnv('HANDY_MASTER_SECRET', 'session-owner-composed-test-secret');
    vi.stubEnv('AUTH_REQUIRED_LOGIN_PROVIDERS', '');
    vi.stubEnv('AUTH_LOGIN_ELIGIBILITY_CACHE_TTL_MS', '0');
});
afterAll(() => vi.unstubAllEnvs());

it('joins Home physical-owner Session forwarding to the actual receiver and refuses custody withdrawal before disclosure', async () => {
    await withTempDir('mi1-session-home-', async directory => {
        const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_SERVER_URL', 'HAPPIER_ACTIVE_SERVER_ID',
            'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_PUBLIC_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
        env.patch({ HAPPIER_HOME_DIR: directory, HAPPIER_ACTIVE_SERVER_ID: 'session-owner-composed',
            HAPPIER_LOCAL_SERVER_URL: undefined, HAPPIER_PUBLIC_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
        reloadConfiguration();
        const installation = await readOrCreateInstallationIdentity();
        const serverBoundaryPath = '../../../../apps/server/sources/app/api/testkit/installedSessionExternalActionStorage';
        const { startPhysicalOwnerSessionRpcBoundary } = await import(serverBoundaryPath) as {
            startPhysicalOwnerSessionRpcBoundary(input: { installation: MachineInstallationIdentityV1;
                receive(request: SocketRpcRequestPayload): Promise<unknown> }): Promise<{
                    baseUrl: string; ownerToken: string; homeId: string;
                    observedHttp: Array<{ route: string; status: number }>; startedHttp: string[]; withdraw(): void; close(): Promise<void>;
                    call(authority: 'present_user' | 'account_automation', sessionSource?: boolean): Promise<unknown>;
                }>;
        };
        let receiver: ((request: SocketRpcRequestPayload) => Promise<unknown>) | undefined;
        const boundary = await startPhysicalOwnerSessionRpcBoundary({ installation, receive: async request => {
            if (!receiver) throw new Error('Session receiver not attached');
            return await receiver(request);
        } });
        let clientForCleanup: ReturnType<ApiClient['sessionSyncClient']> | undefined;
        try {
            await runWithServerHttpBaseUrl(boundary.baseUrl, async () => {
                env.patch({ HAPPIER_SERVER_URL: boundary.baseUrl });
                reloadConfiguration();
                expect(configuration.apiServerUrl, 'Canonical configuration must select the fixture Home').toBe(boundary.baseUrl);
                expect(resolveServerHttpBaseUrl(), 'Session transport must use the same Home as the explicit AccessKey preflight').toBe(boundary.baseUrl);
                // Let the real AccessKey owner establish the already-persisted tuple
                // before the Session transport connects; no lifecycle method is mocked.
                await ensureSessionMachineAccessKeyBinding({ serverUrl: boundary.baseUrl, token: boundary.ownerToken,
                    sessionId: 'session', machineId: 'machine' });
                const api = await ApiClient.create({ token: boundary.ownerToken, encryption: null });
                api.setLocalMachineId('machine');
                api.setServerFeaturesSnapshotProvider(() => ({ status: 'ready', features: FeaturesResponseSchema.parse({ features: {},
                    capabilities: { serverIdentity: { serverIdentityId: boundary.homeId } } }) }));
                const sessionConnected = new Promise<void>(resolve => { socketIoBoundary.onSessionConnect = resolve; });
                const client = api.sessionSyncClient(createPlainSessionFixture({ id: 'session' }), { durableMutationDeliveryInitiallyActive: false });
                clientForCleanup = client;
                expect(client.getServerBinding().serverUrl).toBe(boundary.baseUrl);
                let withdrawBeforeReceiver = false;
                const delivered = vi.fn(async (_event: string, request: Parameters<typeof client.rpcHandlerManager.handleRequest>[0]) => {
                    if (withdrawBeforeReceiver) boundary.withdraw();
                    return await client.rpcHandlerManager.handleRequest(request);
                });
                receiver = request => delivered('', request);
                // Home may target only a connected receiver. Let the real Session
                // supervisor finish its AccessKey/Socket handshake before forwarding.
                await sessionConnected;
                expect(socketIoBoundary.connected).toBeGreaterThan(0);
                for (const authority of ['present_user', 'account_automation'] as const) {
                    expect(await boundary.call(authority), JSON.stringify({ http: boundary.observedHttp, startedHttp: boundary.startedHttp, socketIoBoundary })).toMatchObject({ ok: true,
                        result: { values: { MI1_OWNER_PREVIEW: { value: 'owned-preview' } } } });
                }
                expect(delivered).toHaveBeenCalledTimes(2);
                expect(await boundary.call('present_user', true)).toEqual(expect.objectContaining({
                    ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN,
                }));
                expect(delivered).toHaveBeenCalledTimes(2);
                withdrawBeforeReceiver = true;
                const refused = await boundary.call('present_user');
                expect(refused).toEqual({ ok: true,
                    result: expect.objectContaining({ errorCode: 'agent_isolation_unavailable' }) });
                expect(JSON.stringify(refused)).not.toContain('owned-preview');
                expect(delivered).toHaveBeenCalledTimes(3);
                const currentnessStatuses = boundary.observedHttp.filter(response => response.route === '/v1/machines/:id/admission/verify')
                    .map(response => response.status);
                expect(currentnessStatuses.filter(status => status === 200).length).toBeGreaterThanOrEqual(2);
                expect(currentnessStatuses).toContain(403);
                console.info(JSON.stringify({ gate: 'home-session-owner-currentness', readySocket: true,
                    ownerPerson: true, ownerAutomation: true, sessionSourceBeforeDelivery: true,
                    custodyWithdrawalNoDisclosure: true, currentnessStatuses }));
            });
        } finally {
            socketIoBoundary.onSessionConnect = undefined;
            await clientForCleanup?.close();
            await boundary.close();
            env.restore();
            reloadConfiguration();
        }
    });
});
