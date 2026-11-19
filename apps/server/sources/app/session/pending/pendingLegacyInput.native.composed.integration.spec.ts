import { randomUUID } from 'node:crypto';
import axios from 'axios';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { AgentSessionRuntime, AgentSessionRuntimeContext } from '@happier-dev/plugin-sdk/agents/runtime';
import { FeaturesResponseSchema } from '@happier-dev/protocol';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';

import { db } from '@/storage/db';
import { decodeStoredSessionMessage } from '@/storage/sessionMessageContent';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createAuthenticatedFakeSocket, createSocketRoomDiscoveryHarness, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { sessionUpdateHandler } from '@/app/api/socket/sessionUpdateHandler';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';
import { enqueuePendingMessage } from './pendingMessageService';
import { ApiSessionClient } from '../../../../../cli/src/api/session/sessionClient';
import { createPlainSessionFixture } from '../../../../../cli/src/testkit/backends/sessionFixtures';
import { encodeBase64, encrypt } from '../../../../../cli/src/api/encryption';
import { createTestMetadata } from '../../../../../cli/src/testkit/backends/sessionMetadata';
import { createApiSessionSocketStub } from '../../../../../cli/src/testkit/backends/apiSessionSocketHarness';
import { createNativeAgentSessionOperations } from '../../../../../cli/src/agent/runtime/registry/engineRegistry/nativeAgentSession';
import { MessageQueue2 } from '../../../../../cli/src/agent/runtime/modeMessageQueue';
import { combinePermissionModeQueuedPrompts, type PermissionModeQueuedPrompt, type PermissionModeQueuedPromptMode } from '../../../../../cli/src/agent/runtime/permissions/queuedPrompt';
import { registerPermissionModeMessageQueueBinding } from '../../../../../cli/src/agent/runtime/permissions/bindModeQueue';
import { createSessionProviderInputConsumer } from '../../../../../cli/src/agent/runtime/session/input/sessionProviderInputConsumer';
import { createSessionProviderInputConsumerSessionAdapter } from '../../../../../cli/src/agent/runtime/waitForNextPermissionModeMessage';
import { bindSessionProviderInputOutcome, createSessionProviderInputOutcomeBinding } from '../../../../../cli/src/agent/runtime/session/input/providerInputOutcome';

let harness: LightSqliteHarness;
beforeAll(async () => {
    harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-legacy-native-input-', initAuth: true,
        env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional' } });
}, 120_000);
afterAll(async () => { await harness?.close(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(['plain', 'e2ee'] as const)('commits %s legacy user text before native provider rejection and retains the exact blocked input for retry', async encryptionMode => {
    const owner = await db.account.create({ data: { encryptionMode } });
    const storedSession = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode } });
    const machineId = randomUUID();
    await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: '{}' } });
    await db.accessKey.create({ data: { accountId: owner.id, machineId, sessionId: storedSession.id, data: 'opaque' } });
    const serverSocket = createAuthenticatedFakeSocket({ id: randomUUID(), nsp: { server: createSocketRoomDiscoveryHarness(async () => []) } });
    const presence = createSessionPublisherPresence();
    const binding = { accountId: owner.id, machineId, sessionId: storedSession.id };
    const publisher = await presence.registerPublisher({ socket: serverSocket, binding, completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
    if (publisher.status !== 'registered') throw new Error('Expected current publisher');
    sessionUpdateHandler(owner.id, serverSocket as unknown as Parameters<typeof sessionUpdateHandler>[1], {
        connectionType: 'session-scoped', socket: serverSocket, userId: owner.id, sessionId: storedSession.id,
    } as unknown as Parameters<typeof sessionUpdateHandler>[2], { presence, binding });
    const authentication = createPresentUserSessionAccessAuthentication();
    const localId = randomUUID();
    const text = 'First line\nKeep this exact user text';
    const payload = { role: 'user', content: { type: 'text', text } } as const;
    const encryptionKey = new Uint8Array(32).fill(3);
    const content = encryptionMode === 'plain' ? { t: 'plain', v: payload } as const
        : { t: 'encrypted', c: encodeBase64(encrypt(encryptionKey, 'legacy', payload)) } as const;
    expect(await enqueuePendingMessage({ actorUserId: owner.id, authentication, sessionId: storedSession.id,
        localId, content, requestedAction: { v: 1, kind: 'enqueue' } })).toMatchObject({ ok: true });
    const socket = createApiSessionSocketStub({ connected: true, emitWithAck: async (event, input) => {
        let response: unknown;
        await getSocketHandler(serverSocket, event)(input, (value: unknown) => { response = value; });
        return response;
    } });
    const userSocket = createApiSessionSocketStub({ connected: true });
    vi.stubGlobal('fetch', async () => Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: {
        encryption: { storagePolicy: 'optional', allowAccountOptOut: true, defaultAccountMode: 'plain' },
        session: { pendingInput: { protocolVersion: 5 }, runtimeActivity: { protocolVersion: 2 }, publisherAuthority: { protocolVersion: 1 } },
    } })));
    const token = `header.${Buffer.from(JSON.stringify({ sub: owner.id })).toString('base64url')}.signature`;
    const sessionFixture = createPlainSessionFixture({ id: storedSession.id,
        pendingCount: 1, pendingVersion: 1, metadata: createTestMetadata({ machineId }) });
    const client = new ApiSessionClient(token, encryptionMode === 'plain' ? sessionFixture : {
        ...sessionFixture, encryptionMode: 'e2ee', encryptionKey, encryptionVariant: 'legacy',
    }, {
        localMachineId: machineId, durableMutationDeliveryInitiallyActive: false,
        metadataAuthority: { kind: 'owner', credentials: { token, encryption: null } },
        transport: { serverId: 'legacy-home', serverUrl: 'https://legacy-home.example.test',
            createAccountUpdatesSocket: () => userSocket,
            createSessionSocketTransport: () => ({ socket, transport: createSocketTransportAdapter(socket) }) },
    });
    const queue = new MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>(
        mode => JSON.stringify(mode), { batcher: combinePermissionModeQueuedPrompts });
    registerPermissionModeMessageQueueBinding({ session: client, queue,
        getCurrentPermissionMode: () => 'default', setCurrentPermissionMode: () => {} });
    const consumer = createSessionProviderInputConsumer({ messageQueue: queue,
        session: createSessionProviderInputConsumerSessionAdapter(client), reconcileWhenEmpty: 'skip', refreshBeforeQueuedBatch: false });
    let providerCalls = 0;
    let committedBeforeSend: unknown;
    const provider: AgentSessionRuntime = {
        async send() {
            providerCalls++;
            committedBeforeSend = decodeStoredSessionMessage(await db.sessionMessage.findUnique({ where: {
                sessionId_localId: { sessionId: storedSession.id, localId } } }));
            return { status: 'rejected', diagnostic: { code: 'provider_configuration_unavailable', severity: 'error' }, retryable: true };
        },
        watch() { return { dispose() {} }; }, dispose() {},
    };
    const controller = new AbortController();
    const runtime = createNativeAgentSessionOperations(provider, storedSession.id, undefined, undefined, undefined, undefined, undefined, {
        context: { signal: controller.signal } as AgentSessionRuntimeContext, cwd: '/tmp/project', connectedAccounts: [],
        capabilities: { open: ['create'], delivery: ['newTurn'], cancel: false },
        cancellation: { declared: false }, configuration: { declared: false }, compaction: { capability: null },
    });
    const outcomes = createSessionProviderInputOutcomeBinding({ getTarget: () => client });
    const unbind = bindSessionProviderInputOutcome({ runtime, observe: outcomes.observeProviderInputOutcome,
        wakePendingMaterialization: () => client.wakePendingMaterialization() });
    try {
        await withAuthenticatedTestApp(sessionPendingRoutes, async app => {
            // HTTP is the process boundary; use the real authenticated route and SQLite storage.
            vi.spyOn(axios, 'post').mockImplementation(async (url, body) => {
                const response = await app.inject({ method: 'POST', url: new URL(String(url)).pathname,
                    headers: { 'x-test-user-id': owner.id }, payload: body });
                expect(response.statusCode).toBe(200);
                return { status: response.statusCode, data: response.json() };
            });
            await new Promise<void>(resolve => client.once('session-sync-server-contract', resolve));
            expect(await client.materializeNextPendingMessageSafely()).toMatchObject({ type: 'materialized', localId });
            const input = await consumer.waitForNextInput({ abortSignal: controller.signal });
            expect(input?.message.text).toBe(text);
            await expect(runtime.sendTurnPrompt(input!.message.text, { localId, turnId: randomUUID() })).rejects.toThrow();
            expect(committedBeforeSend).toMatchObject({ content, deliveryResolution: null });
            await vi.waitFor(async () => expect(await db.sessionPendingMessage.findUnique({ where: {
                sessionId_localId: { sessionId: storedSession.id, localId } } })).toMatchObject({
                content, status: 'queued', deliveryState: 'blocked', deliveryBlockedReason: 'provider_unavailable_before_acceptance' }));
            expect(providerCalls).toBe(1);
            expect(decodeStoredSessionMessage(await db.sessionMessage.findUnique({ where: {
                sessionId_localId: { sessionId: storedSession.id, localId } } })))
                .toMatchObject({ content, deliveryResolution: null, acceptedTurnId: null });
            expect(await db.sessionMessage.count({ where: { sessionId: storedSession.id } })).toBe(1);
            const restored = await app.inject({ method: 'PATCH',
                url: `/v2/sessions/${storedSession.id}/pending/${localId}/action`, headers: { 'x-test-user-id': owner.id },
                payload: { requestedAction: { v: 1, kind: 'enqueue' } } });
            expect(restored.statusCode).toBe(200);
            expect(await db.sessionPendingMessage.findUnique({ where: { sessionId_localId: { sessionId: storedSession.id, localId } } }))
                .toMatchObject({ content, status: 'queued', deliveryState: null, deliveryBlockedReason: null });
            expect(await db.sessionMessage.count({ where: { sessionId: storedSession.id } })).toBe(1);
        });
    } finally {
        controller.abort(); unbind(); await runtime.resetOrDisposeRuntime(); await client.close();
    }
});
