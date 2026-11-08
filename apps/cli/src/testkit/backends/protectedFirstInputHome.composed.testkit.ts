import axios from 'axios';
import { randomUUID } from 'node:crypto';
import { expect, vi } from 'vitest';
import { buildTrustedHostSessionInputAdmissionV1, FeaturesResponseSchema,
    SESSION_INPUT_REQUEST_META_KEY, SESSION_MESSAGE_PROVENANCE_META_KEY } from '@happier-dev/protocol';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { SessionOwnerMetadataEnvelopeV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';

import { ApiSessionClient } from '@/api/session/sessionClient';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import type { Metadata } from '@/api/types';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createInitialHostRuntimeActivityMutation } from '@/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import { createApiSessionSocketStub, resolveApiSessionSocketDefaultAck } from './apiSessionSocketHarness';
import { createPlainSessionFixture, createSessionRecordFixture } from './sessionFixtures';
import { createTestMetadata } from './sessionMetadata';
import { installEmptyProjectAccountRowsHttpBoundary } from '../http/projectAccountRows';
import { createLightSqliteHarness } from '../../../../server/sources/testkit/lightSqliteHarness';
import { createSignedAccountContentBinding } from '../../../../server/sources/testkit/accountEncryption';
import { db } from '../../../../server/sources/storage/db';
import { createPresentUserSessionAccessAuthentication } from '../../../../server/sources/app/session/access/sessionAccessAuthentication.testkit';
import { enqueuePendingMessage } from '../../../../server/sources/app/session/pending/pendingMessageService';
import { createSessionPublisherPresence } from '../../../../server/sources/app/presence/sessionPublisherPresence';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, getSocketHandler } from '../../../../server/sources/app/api/testkit/socketHarness';
import { sessionUpdateHandler } from '../../../../server/sources/app/api/socket/sessionUpdateHandler';
import { buildPendingChangedUpdate } from '../../../../server/sources/app/events/eventPayloadBuilders';
import { createAuthenticatedTestApp } from '../../../../server/sources/app/api/testkit/sqliteFastify';
import { sessionPendingRoutes } from '../../../../server/sources/app/api/routes/session/pendingRoutes';
import { registerSessionMessageRoutes } from '../../../../server/sources/app/api/routes/session/registerSessionMessageRoutes';
import { registerAccountEncryptionRoutes } from '../../../../server/sources/app/api/routes/account/registerAccountEncryptionRoutes';
import { registerSessionPatchRoute } from '../../../../server/sources/app/api/routes/session/registerSessionPatchRoute';

/** Real Home storage and Session socket handlers; only HTTP/socket transport is substituted. */
export async function createProtectedFirstInputHomeHarness() {
    const harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-protected-first-input-', initAuth: true });
    return {
        close: () => harness.close(),
        async createSession(text: string, options: Readonly<{ enqueueImmediately?: boolean; metadata?: Partial<Metadata> }> = {}) {
            harness.resetEnv({ HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' });
            const account = await db.account.create({ data: { ...createSignedAccountContentBinding(), encryptionMode: 'plain' } });
            const machineId = randomUUID();
            const sessionId = randomUUID();
            const localId = randomUUID();
            const token = `header.${Buffer.from(JSON.stringify({ sub: account.id })).toString('base64url')}.signature`;
            const metadata = createTestMetadata({ machineId, permissionMode: 'default', ...options.metadata });
            const fields = buildSessionMetadataEnvelopeFields({ credentials: { token, encryption: null },
                accountEncryptionMode: 'plain', metadata, agentState: null, storedContentMode: 'plain' });
            await db.session.create({ data: { id: sessionId, accountId: account.id, tag: randomUUID(), encryptionMode: 'plain',
                metadata: fields.sharedMetadata.ciphertext, metadataLayoutVersion: 1,
                ownerMetadata: JSON.stringify(fields.ownerMetadata), metadataVersion: 0, agentState: null, agentStateVersion: 0 } });
            await db.machine.create({ data: { id: machineId, accountId: account.id, metadata: '{}',
                operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
            await db.accessKey.create({ data: { accountId: account.id, machineId, sessionId, data: 'encrypted' } });
            const serverSocket = createAuthenticatedFakeSocket({ id: randomUUID(), nsp: { server: createSocketRoomDiscoveryHarness(async () => []) } });
            const binding = { accountId: account.id, sessionId, machineId };
            const presence = createSessionPublisherPresence();
            const publisher = await presence.registerPublisher({ socket: serverSocket, binding,
                completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
            expect(publisher.status).toBe('registered');
            sessionUpdateHandler(account.id, serverSocket as unknown as Parameters<typeof sessionUpdateHandler>[1], {
                connectionType: 'session-scoped', socket: serverSocket, userId: account.id, sessionId,
            } as unknown as Parameters<typeof sessionUpdateHandler>[2], { presence, binding });
            const admission = buildTrustedHostSessionInputAdmissionV1('ui');
            const enqueue = async () => expect(await enqueuePendingMessage({ actorUserId: account.id, sessionId, localId,
                authentication: createPresentUserSessionAccessAuthentication(), requestedAction: { v: 1, kind: 'enqueue' },
                content: { t: 'plain', v: { role: 'user', content: { type: 'text', text }, meta: {
                    sentFrom: 'ui', [SESSION_INPUT_REQUEST_META_KEY]: admission.request, [SESSION_MESSAGE_PROVENANCE_META_KEY]: admission.provenance,
                } } } })).toMatchObject({ ok: true, didWrite: true });
            const enqueueImmediately = options.enqueueImmediately !== false;
            if (enqueueImmediately) await enqueue();
            const packets: Array<{ event: string; request: unknown; response: unknown }> = [];
            const socket = createApiSessionSocketStub({ connected: true,
                emit(event, args) {
                    if (event === 'ping' && typeof args[0] === 'function') args[0]();
                    else if (serverSocket.handlers.has(event)) void getSocketHandler(serverSocket, event)(...args);
                }, emitWithAck: async (event, request) => {
                if (!serverSocket.handlers.has(event)) return resolveApiSessionSocketDefaultAck(event, request);
                let response: unknown;
                await getSocketHandler(serverSocket, event)(request, (value: unknown) => { response = value; });
                packets.push({ event, request, response });
                return response;
            } });
            const publishPendingChanged = async () => {
                const state = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
                socket.trigger('update', buildPendingChangedUpdate({ sessionId, pendingVersion: state.pendingVersion,
                    pendingCount: state.pendingCount, pendingBlockedCount: state.pendingBlockedCount }, state.seq, randomUUID()));
            };
            const restoreHttp = installEmptyProjectAccountRowsHttpBoundary();
            const pendingApp = createAuthenticatedTestApp();
            sessionPendingRoutes(pendingApp);
            registerSessionMessageRoutes(pendingApp);
            registerAccountEncryptionRoutes(pendingApp);
            registerSessionPatchRoute(pendingApp);
            await pendingApp.ready();
            const priorPatch = axios.patch;
            const patch = vi.spyOn(axios, 'patch').mockImplementation(async (url, payload, ...args) => {
                const pathname = new URL(String(url)).pathname;
                if (pathname === `/v2/sessions/${sessionId}`) {
                    const response = await pendingApp.inject({ method: 'PATCH', url: pathname,
                        headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), 'x-test-user-id': account.id }, payload });
                    if (response.statusCode !== 200) throw Object.assign(new Error(`Session PATCH failed: ${response.statusCode} ${response.body}`), {
                        isAxiosError: true, response: { status: response.statusCode, data: response.json() },
                    });
                    return { status: response.statusCode, data: response.json() };
                }
                return await priorPatch(url, payload, ...args);
            });
            const priorPost = axios.post;
            const post = vi.spyOn(axios, 'post').mockImplementation(async (url, payload, ...args) => {
                const pathname = new URL(String(url)).pathname;
                if (pathname === `/v2/sessions/${sessionId}/pending` || pathname.startsWith(`/v2/sessions/${sessionId}/pending/`)) {
                    const response = await pendingApp.inject({ method: 'POST', url: pathname,
                        headers: { 'x-test-user-id': account.id }, payload });
                    if (response.statusCode !== 200) throw new Error(`Pending HTTP ${pathname} failed: ${response.statusCode} ${response.body}`);
                    await publishPendingChanged();
                    return { status: response.statusCode, data: response.json() };
                }
                return await priorPost(url, payload, ...args);
            });
            const priorGet = axios.get;
            const get = vi.spyOn(axios, 'get').mockImplementation(async (url, ...args) => {
                const pathname = new URL(String(url)).pathname;
                if (pathname === `/v2/sessions/${sessionId}`) {
                    const row = await db.session.findUniqueOrThrow({ where: { id: sessionId } });
                    return { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
                        metadataLayoutVersion: 1, metadata: row.metadata, metadataVersion: row.metadataVersion,
                        ownerMetadata: row.ownerMetadata === null ? null : SessionOwnerMetadataEnvelopeV1Schema.parse(JSON.parse(row.ownerMetadata)),
                        agentState: row.agentState, agentStateVersion: row.agentStateVersion, share: null, seq: row.seq,
                        pendingCount: row.pendingCount, pendingBlockedCount: row.pendingBlockedCount, pendingVersion: row.pendingVersion }) } };
                }
                if (pathname.startsWith('/v1/account/encryption') || pathname === `/v1/sessions/${sessionId}/messages` || pathname.startsWith(`/v2/sessions/${sessionId}/messages/`)) {
                    const response = await pendingApp.inject({ method: 'GET', url: pathname,
                        headers: { 'x-test-user-id': account.id } });
                    if (response.statusCode !== 200) throw Object.assign(new Error(`Transcript HTTP ${pathname} failed: ${response.statusCode}`), {
                        isAxiosError: true, response: { status: response.statusCode, data: response.json() },
                    });
                    return { status: response.statusCode, data: response.json() };
                }
                return await priorGet(url, ...args);
            });
            vi.stubGlobal('fetch', async () => Response.json(FeaturesResponseSchema.parse({
                features: { sharing: { pendingQueueV2: { enabled: true } } }, capabilities: {
                    session: { pendingInput: { protocolVersion: 5 }, runtimeActivity: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 1 } },
                },
            })));
            const client = new ApiSessionClient(token, createPlainSessionFixture({ id: sessionId, metadata,
                pendingCount: enqueueImmediately ? 1 : 0, pendingVersion: enqueueImmediately ? 1 : 0 }), {
                localMachineId: machineId, durableMutationDeliveryInitiallyActive: false,
                metadataAuthority: { kind: 'owner', credentials: { token, encryption: null } },
                initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({ sessionId, agentRuntimeApplicability: 'supported' })],
                transport: { serverId: 'protected-first-input-home', serverUrl: 'https://first-input.example.test',
                    createAccountUpdatesSocket: () => createApiSessionSocketStub({ connected: true }),
                    createSessionSocketTransport: () => ({ socket, transport: createSocketTransportAdapter(socket) }) },
            });
            await vi.waitFor(() => expect(socket.getHandler('session')).toBeTypeOf('function'));
            await client.claimCurrentSessionPublisherAuthorityForStartup();
            await client.activateDurableMutationDelivery();
            return { client, sessionId, machineId, localId, token, metadata, packets,
                async retryFirstInput() {
                    const response = await pendingApp.inject({ method: 'PATCH',
                        url: `/v2/sessions/${sessionId}/pending/${localId}/action`,
                        headers: { 'x-test-user-id': account.id }, payload: { requestedAction: { v: 1, kind: 'enqueue' } } });
                    expect(response.statusCode).toBe(200);
                },
                async enqueueFirstInput() {
                    await enqueue();
                    await publishPendingChanged();
                },
                readTranscript: () => db.sessionMessage.findMany({ where: { sessionId }, orderBy: { seq: 'asc' } }),
                readPending: () => db.sessionPendingMessage.findMany({ where: { sessionId } }),
                async close() { await client.close(); await pendingApp.close(); patch.mockRestore(); post.mockRestore(); get.mockRestore(); restoreHttp(); },
            };
        },
    };
}
