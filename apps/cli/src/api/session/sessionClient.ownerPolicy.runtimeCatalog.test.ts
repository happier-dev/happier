import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { ExecutionRunStartRequestSchema } from '@happier-dev/protocol/execution/runs/startRequest';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { decodePlainArtifactStoredContent, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';

import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { createDeferred } from '@/testkit/async/deferred';
import { createTestApiSessionClient } from '@/testkit/backends/createTestApiSessionClient';
import { createPlainSessionFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub } from '@/testkit/backends/apiSessionSocketHarness';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createSessionScopedSocketConnection } from './sockets';
import { ApiSessionClient } from './sessionClient';

const { ioBoundary } = vi.hoisted(() => ({ ioBoundary: vi.fn() }));
// Socket.IO is the network boundary; Session custody, approval governance and
// Artifact storage remain the actual production owners beneath it.
vi.mock('socket.io-client', () => ({ io: ioBoundary }));

const clients: ApiSessionClient[] = [];
const homes: Server[] = [];
const releaseHeldResponses: Array<() => void> = [];
afterEach(async () => {
    for (const release of releaseHeldResponses.splice(0)) release();
    await Promise.all(clients.splice(0).map(client => client.close()));
    await Promise.all(homes.splice(0).map(home => new Promise<void>((resolve, reject) => {
        home.close(error => error ? reject(error) : resolve());
    })));
    resetInMemoryAccountSettingsContextForTests();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
});

describe('ApiSessionClient owner policy retirement', () => {
    it('does not create a second approval Artifact when its real Session closes during an owning Settings read', async () => {
        vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_MODE', 'auto');
        vi.stubEnv('HAPPIER_ACCOUNT_SETTINGS_TTL_MS', '0');
        vi.stubEnv('HAPPIER_FEATURE_EXECUTION_RUNS__ENABLED', '1');
        vi.stubEnv('HAPPIER_BUILD_FEATURES_ALLOW', 'execution.runs');
        vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', '');
        const accountId = 'session-policy-owner';
        const token = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.`;
        const credentials = { token, encryption: null } as const;
        const sessionId = 'owner-policy-retirement';
        const serverId = 'owner-policy-home';
        const settings = AccountSettingsV2GetResponseSchema.parse({ version: 11, content: { t: 'plain', v: {
            schemaVersion: 6, actionsSettingsV1: { v: 1, actions: {
                'execution.run.start': { enabled: true, approvalRequiredSurfaces: ['rpc'] },
            } },
        } } });
        const currentness = AccountEncryptionCurrentnessResponseSchema.parse({
            mode: 'plain', version: 11, settingsVersion: 11, signingKeyFingerprint: null,
            contentKeyFingerprint: null, updatedAt: 1,
            recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' },
        });
        const heldSettingsRead = createDeferred();
        const releaseSettingsRead = createDeferred();
        releaseHeldResponses.push(() => releaseSettingsRead.resolve());
        let holdSettings = false;
        const artifactPosts: string[] = [];
        const artifacts = new Map<string, Readonly<Record<string, unknown>>>();
        const httpFailures: unknown[] = [];
        const home = createServer((request, response) => {
            void (async () => {
                response.setHeader('Content-Type', 'application/json');
                if (request.method === 'GET' && request.url === '/v2/account/settings') {
                    expect(request.headers.authorization).toBe(`Bearer ${token}`);
                    if (holdSettings) {
                        heldSettingsRead.resolve();
                        await releaseSettingsRead.promise;
                    }
                    response.end(JSON.stringify(settings));
                } else if (request.method === 'GET' && request.url === '/v1/account/encryption/currentness') {
                    response.end(JSON.stringify(currentness));
                } else if (request.method === 'GET' && request.url === '/v1/account/encryption') {
                    response.end(JSON.stringify({ mode: 'plain', updatedAt: 1 }));
                } else if (request.method === 'POST' && request.url === '/v1/artifacts') {
                    expect(request.headers.authorization).toBe(`Bearer ${token}`);
                    const chunks: Buffer[] = [];
                    for await (const chunk of request) chunks.push(Buffer.from(chunk));
                    const wire: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    if (!wire || typeof wire !== 'object' || !('id' in wire) || typeof wire.id !== 'string'
                        || !('body' in wire) || typeof wire.body !== 'string'
                        || !('dataEncryptionKey' in wire) || typeof wire.dataEncryptionKey !== 'string') {
                        throw new Error('Invalid Artifact create wire');
                    }
                    const body = decodePlainArtifactStoredContent(wire.body);
                    if (!body || typeof body !== 'object' || !('body' in body) || typeof body.body !== 'string') {
                        throw new Error('Invalid Plain Artifact body');
                    }
                    const approval = StoredApprovalRequestSchema.parse(JSON.parse(body.body));
                    expect(approval).toMatchObject({ actionId: 'execution.run.start', status: 'open' });
                    // The real Home supplies a durable human rejection, so the
                    // first admitted request settles without a fabricated runtime lease.
                    const rejected = StoredApprovalRequestSchema.parse({ ...approval, status: 'rejected',
                        decision: { kind: 'reject', decidedAtMs: approval.updatedAtMs },
                    });
                    artifacts.set(wire.id, { id: wire.id, ownerAccountId: accountId, access: 'owner',
                        encryptionMode: 'plain', publicAudience: 'none',
                        header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(rejected, { legacyServerId: serverId })),
                        body: encodePlainArtifactStoredContent({ body: JSON.stringify(rejected) }),
                        dataEncryptionKey: wire.dataEncryptionKey, headerVersion: 2, bodyVersion: 2,
                        seq: artifactPosts.length + 1, createdAt: 1, updatedAt: 2,
                    });
                    artifactPosts.push(wire.id);
                    response.end(JSON.stringify({ id: wire.id, headerVersion: 1, bodyVersion: 1 }));
                } else if (request.method === 'GET' && request.url?.startsWith('/v1/artifacts/')) {
                    const artifact = artifacts.get(decodeURIComponent(request.url.slice('/v1/artifacts/'.length)));
                    response.statusCode = artifact ? 200 : 404;
                    response.end(JSON.stringify(artifact ?? {}));
                } else {
                    response.statusCode = 404;
                    response.end('{}');
                }
            })().catch(error => {
                httpFailures.push(error);
                response.statusCode = 500;
                response.end('{}');
            });
        });
        homes.push(home);
        home.listen(0, '127.0.0.1');
        await once(home, 'listening');
        const address = home.address();
        if (!address || typeof address === 'string') throw new Error('Missing loopback Home address');
        const serverUrl = `http://127.0.0.1:${address.port}`;
        const activityHome = createSessionRuntimeActivityHomeStub({ machineId: 'owner-policy-machine' });
        ioBoundary.mockImplementation(() => createApiSessionSocketStub({
            emitWithAck: (event, payload) => activityHome.answer(event, payload) ?? { ok: true },
        }));
        await withTempDir('happier-session-owner-retirement-', async directory => {
            await runWithServerHttpBaseUrl(serverUrl, async () => {
                const client = createTestApiSessionClient(ApiSessionClient, token, createPlainSessionFixture({
                    id: sessionId, metadata: createTestMetadata({ path: directory, machineId: 'owner-policy-machine' }),
                }), {
                    transport: { serverId, serverUrl,
                        createSessionSocketTransport: ({ sessionId, machineId }) => createSessionScopedSocketConnection({
                            token, sessionId, machineId, serverUrl,
                        }),
                    },
                    metadataAuthority: { kind: 'owner', credentials, readCurrentCredentials: async () => credentials },
                    durableMutationDeliveryInitiallyActive: false,
                });
                clients.push(client);
                const request = ExecutionRunStartRequestSchema.parse({
                    intent: 'plan', backendTarget: { kind: 'backend', backendId: 'not-installed-owner-agent',
                        configuredBackendId: 'not-installed-owner-agent', sourceKind: 'configured' },
                    instructions: 'Read the project and return a plan.', permissionMode: 'read_only',
                    retentionPolicy: 'ephemeral', runClass: 'bounded', ioMode: 'request_response',
                });
                let requestSequence = 0;
                const start = () => client.rpcHandlerManager.handleRequest({
                    method: `${sessionId}:${SESSION_RPC_METHODS.EXECUTION_RUN_START}`, params: request,
                    requestId: `owner-policy-request-${++requestSequence}`,
                    callerAuthority: 'account_automation',
                });
                const first: unknown = await start();
                expect(httpFailures).toEqual([]);
                expect(artifactPosts).toHaveLength(1);
                const originalArtifactId = artifactPosts[0];
                expect(ActionApprovalRequestCreatedResultSchema.parse(first)).toMatchObject({
                    actionId: 'execution.run.start', artifactId: originalArtifactId,
                });
                holdSettings = true;
                const second = start();
                let closeFailure: unknown;
                try {
                    await heldSettingsRead.promise;
                    await client.close();
                    clients.splice(clients.indexOf(client), 1);
                } catch (error) {
                    closeFailure = error;
                } finally { releaseSettingsRead.resolve(); }
                await second;
                if (closeFailure) throw closeFailure;
                expect(httpFailures).toEqual([]);
                expect(artifactPosts).toEqual([originalArtifactId]);
                expect(artifacts.has(originalArtifactId)).toBe(true);
            });
        });
    });
});
