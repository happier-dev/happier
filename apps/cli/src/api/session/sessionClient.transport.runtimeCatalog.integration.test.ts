import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccountEncryptionCurrentnessFixture, createMockSession, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { encodeBase64, encrypt } from '@/api/encryption';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub } from '@/testkit/backends/apiSessionSocketHarness';
import { createSocketTransportAdapter } from '@happier-dev/sync-client';
import { createSessionScopedSocket, createSessionScopedSocketConnection } from './sockets';
import { ApiSessionClient } from './sessionClient';
import { publishServerHttpRuntimeOrigin, resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { createInitialHostRuntimeActivityMutation } from '@/agent/runtime/session/activity/createHostRuntimeActivityProjection';
import { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { createSessionProviderInputConsumerSessionAdapter, waitForNextPermissionModeMessage } from '@/agent/runtime/waitForNextPermissionModeMessage';
import { createSessionProviderInputConsumer } from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import { fetchSessionSnapshotUpdateFromServer } from './snapshotSync';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';

const { mockIo, readStoredCredentials } = vi.hoisted(() => ({
    mockIo: vi.fn(),
    readStoredCredentials: vi.fn(),
}));

vi.mock('socket.io-client', () => ({ io: mockIo }));
vi.mock('axios');
// Credential persistence is an OS boundary. A scoped client must never read it.
vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readStoredCredentials,
}));

describe('ApiSessionClient injected transport', () => {
    let client: ApiSessionClient | undefined;
    beforeEach(() => {
        vi.mocked(axios.get).mockReset().mockResolvedValue({ status: 404, data: {} });
        readStoredCredentials.mockReset().mockResolvedValue(null);
        mockIo.mockReset().mockImplementation(() => createApiSessionSocketStub());
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    });
    afterEach(async () => {
        await client?.close();
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });

    it('delivers Pending from the required startup snapshot without a daemon wake', async () => {
        const sessionId = 'startup-pending-session';
        const fields = buildSessionMetadataEnvelopeFields({ credentials: { token: 'startup-token', encryption: null },
            accountEncryptionMode: 'plain', metadata: createTestMetadata(), agentState: null, storedContentMode: 'plain' });
        const activity = createSessionRuntimeActivityHomeStub({ machineId: 'startup-machine' });
        const socket = createApiSessionSocketStub({ connected: true, emitWithAck: (event, payload) => {
            if (event === 'pending-materialize-next') return {
                ok: true, didMaterialize: true, didWrite: false, localId: 'startup-pending-input',
                pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 2,
                message: { id: null, seq: null, localId: 'startup-pending-input', providerAction: 'send', messageRole: 'user',
                    inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine' },
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'retained pending input' } } },
                    createdAt: 1, updatedAt: 1, deliveryState: { mode: 'provider', unresolved: true } },
            };
            return activity.answer(event, payload) ?? { ok: false };
        } });
        const features = FeaturesResponseSchema.parse({ features: { sharing: { pendingQueueV2: { enabled: true } } },
            capabilities: { session: { runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 3 },
                publisherAuthority: { protocolVersion: 1 } } } });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(features)));
        vi.mocked(axios.get).mockImplementation(async url => String(url).includes(`/v2/sessions/${sessionId}`)
            ? { status: 200, data: { session: createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain',
                metadataLayoutVersion: 1, metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata,
                agentState: fields.agentState, share: null,
                pendingCount: 1, pendingBlockedCount: 0, pendingVersion: 1 }) } }
            : { status: 404, data: {} });
        client = new ApiSessionClient('startup-token', createMockSession({ id: sessionId, encryptionMode: 'plain',
            metadataLayoutVersion: 1, metadata: { v: 1 }, pendingCount: 0, pendingVersion: 0 }), {
            metadataAuthority: { kind: 'shared_editor' }, localMachineId: 'startup-machine',
            durableMutationDeliveryInitiallyActive: false,
            initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({ sessionId,
                agentRuntimeApplicability: 'supported' })],
            transport: { serverId: 'startup-pending-home', serverUrl: 'https://startup-pending.example.test',
                createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
        });
        await vi.waitFor(() => expect(socket.getHandler('session')).toBeTypeOf('function'));
        await expect(client.claimCurrentSessionPublisherAuthorityForStartup()).resolves.toEqual({ status: 'claimed' });
        await client.refreshSessionSnapshotFromServerRequired({ reason: 'startup-drain' });
        expect(client.getPendingQueueState()).toMatchObject({ pendingCount: 1, pendingVersion: 1 });
        await client.activateDurableMutationDelivery();
        const queue = new MessageQueue2<string>(() => 'startup');
        client.onUserMessage(message => { queue.pushImmediate(message.content.text, 'startup'); return true; });
        const consumer = createSessionProviderInputConsumer({ messageQueue: queue,
            session: createSessionProviderInputConsumerSessionAdapter(client), reconcileWhenEmpty: 'skip', refreshBeforeQueuedBatch: false });
        const lifetime = new AbortController();
        try {
            // No update event or pending-wake RPC is supplied. The first input
            // pass must consume the canonical snapshot before it waits for a wake.
            await expect(consumer.waitForNextInput({ abortSignal: lifetime.signal }))
                .resolves.toMatchObject({ message: 'retained pending input', mode: 'startup' });
        } finally { lifetime.abort(); }
    });

    it.each(['owner', 'shared_editor'] as const)('keeps an idle input waiter parked across unchanged layout-one snapshot reads (%s)', async authority => {
        const token = 'idle-owner-token';
        const credentials = { token, encryption: null };
        const metadata = createTestMetadata({ path: '/idle', host: 'idle-host' });
        const fields = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
            metadata, agentState: null, storedContentMode: 'plain' });
        const raw = createSessionRecordFixture({ id: 'idle-session', encryptionMode: 'plain',
            metadataLayoutVersion: 1, metadataVersion: 7, agentStateVersion: 4,
            metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, agentState: fields.agentState, share: null });
        const reads: string[] = [];
        vi.mocked(axios.get).mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            reads.push(path);
            if (path === '/v1/account/encryption/currentness') return { status: 200,
                data: createAccountEncryptionCurrentnessFixture({ mode: 'plain', version: 1, settingsVersion: 7 }) };
            if (path === '/v2/sessions/idle-session') return { status: 200, data: { session: raw } };
            return { status: 404, data: {} };
        });
        // The real producer must cross the real strict tuple reader before exercising its wake carrier.
        await fetchSessionSnapshotUpdateFromServer({ reason: 'session-query', token, sessionId: 'idle-session', credentials,
            accountEncryptionCurrentness: createAccountEncryptionCurrentnessFixture({ mode: 'plain', version: 1, settingsVersion: 7 }),
            mode: 'plain', ctx: null, currentMetadataLayoutVersion: 1, currentMetadataVersion: 7,
            currentAgentStateVersion: 4, currentMetadata: metadata, currentAgentState: null });
        client = new ApiSessionClient(token, createMockSession({ id: 'idle-session', encryptionMode: 'plain',
            metadataLayoutVersion: 1, metadata, metadataVersion: 7, ownerMetadata: null,
            agentState: null, agentStateVersion: 4 }), {
            metadataAuthority: authority === 'owner' ? { kind: 'owner', credentials } : { kind: 'shared_editor' },
            transport: { serverId: 'idle-home', serverUrl: 'https://idle-home.test',
                createSessionSocketTransport: () => {
                    const socket = createApiSessionSocketStub();
                    return { socket: socket as never, transport: createSocketTransportAdapter(socket as never) };
                } },
        });
        await client.refreshSessionSnapshotFromServerRequired({ reason: 'explicit-drain' });
        const session = client;
        const abort = new AbortController();
        const queue = new MessageQueue2<string>(() => 'idle');
        let reResolutions = 0;
        const waiting = waitForNextPermissionModeMessage({ messageQueue: queue, session,
            abortSignal: abort.signal, onMetadataUpdate: async () => {
                reResolutions += 1;
                await session.refreshSessionSnapshotFromServerRequired({ reason: 'primaryTurnRuntimeState' });
            } });
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            reads.length = 0;
            const startedAt = Date.now();
            vi.useFakeTimers({ toFake: ['Date'] });
            for (let second = 0; second < 25; second += 1) {
                vi.setSystemTime(startedAt + (second + 1) * 1_000);
                await session.refreshSessionSnapshotFromServerRequired({ reason: 'explicit-drain' });
                await new Promise<void>(resolve => setImmediate(resolve));
            }
            expect({ reResolutions, currentness: reads.filter(path => path === '/v1/account/encryption/currentness').length,
                sessions: reads.filter(path => path === '/v2/sessions/idle-session').length }).toEqual({
                reResolutions: 0, currentness: authority === 'owner' ? 25 : 0, sessions: 25,
            });
            raw.metadataVersion += 1;
            await session.refreshSessionSnapshotFromServerRequired({ reason: 'explicit-drain' });
            await vi.waitFor(() => expect(reResolutions).toBe(1));
            await new Promise<void>(resolve => setImmediate(resolve));
            const repaired = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: 'plain',
                metadata: { ...metadata, summary: { text: 'Repaired authoritative content', updatedAt: 2 } },
                agentState: null, storedContentMode: 'plain' });
            raw.metadata = repaired.sharedMetadata.ciphertext;
            raw.ownerMetadata = repaired.ownerMetadata;
            const repairWake = session.waitForMetadataUpdate(abort.signal);
            await session.refreshSessionSnapshotFromServerRequired({ reason: 'explicit-drain' });
            expect(session.getMetadataSnapshot()?.summary?.text).toBe('Repaired authoritative content');
            await expect(repairWake).resolves.toBe(true);
        } finally {
            abort.abort();
            await waiting;
        }
    });

    it('renews established startup presence before native runtime readiness and retires renewal on close', async () => {
        const home = createSessionRuntimeActivityHomeStub({ machineId: 'startup-machine' });
        const socket = createApiSessionSocketStub({ connected: true,
            emitWithAck: (event, payload) => home.answer(event, payload) ?? { ok: false } });
        const features = FeaturesResponseSchema.parse({ features: { sharing: { pendingQueueV2: { enabled: true } } },
            capabilities: { session: { runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 3 },
                publisherAuthority: { protocolVersion: 1 } } } });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(features), { status: 200,
            headers: { 'content-type': 'application/json' } })));
        client = new ApiSessionClient('startup-token', createMockSession({ id: 'startup-session', encryptionMode: 'plain' }), {
            metadataAuthority: { kind: 'shared_editor' },
            localMachineId: 'startup-machine',
            durableMutationDeliveryInitiallyActive: false,
            initialRegisteredSessionStateFieldMutations: [createInitialHostRuntimeActivityMutation({
                sessionId: 'startup-session', agentRuntimeApplicability: 'supported' })],
            transport: { serverId: 'startup-home', serverUrl: 'https://startup-home.example.test',
                createSessionSocketTransport: () => ({ socket: socket as never, transport: createSocketTransportAdapter(socket as never) }) },
        });
        await vi.waitFor(() => expect(socket.getHandler('session')).toBeTypeOf('function'));
        vi.useFakeTimers();
        const observations: number[] = [];
        const observe = (event: string) => {
            if (event === 'session-alive') observations.push(Date.now());
        };
        socket.emit.mockImplementation(observe);
        socket.volatile.emit.mockImplementation(observe);
        await expect(client.claimCurrentSessionPublisherAuthorityForStartup()).resolves.toEqual({ status: 'claimed' });
        await vi.advanceTimersByTimeAsync(11 * 60_000);
        expect(observations.length).toBeGreaterThan(1);
        expect(Date.now() - observations.at(-1)!).toBeLessThanOrEqual(configuration.sessionKeepAliveIdleMs);
        // Clock corrections cannot retire a live publisher's renewal.
        vi.setSystemTime(Date.now() - configuration.sessionKeepAliveIdleMs * 2);
        await vi.advanceTimersByTimeAsync(configuration.sessionKeepAliveIdleMs);
        expect(observations.at(-1)).toBe(Date.now());
        client.keepAlive(true, 'remote');
        const thinkingStartedAt = Date.now();
        await vi.advanceTimersByTimeAsync(configuration.sessionKeepAliveThinkingMs);
        expect(observations.at(-1)).toBe(thinkingStartedAt + configuration.sessionKeepAliveThinkingMs);
        client.keepAlive(false, 'local');
        const settledAt = Date.now();
        await vi.advanceTimersByTimeAsync(configuration.sessionKeepAliveIdleMs);
        expect(observations.at(-1)).toBe(settledAt + configuration.sessionKeepAliveIdleMs);
        await client.close();
        const before = [...observations];
        await vi.advanceTimersByTimeAsync(configuration.sessionKeepAliveIdleMs * 2);
        expect(observations).toEqual(before);
    });

    it('reads an E2EE shared-editor follow snapshot without Account lookup or owner-state disclosure', async () => {
        const token = 'shared-runtime-token';
        const encryptionKey = new Uint8Array(32).fill(17);
        const sharedMetadata = { v: 1 as const, summary: { text: 'Recipient-safe summary', updatedAt: 1 },
            publicAgentState: { completedRequests: { done: { tool: 'Bash', createdAt: 1, completedAt: 2, status: 'approved' as const } } } };
        const privateTuple = buildSessionMetadataEnvelopeFields({
            credentials: { token, encryption: null }, accountEncryptionMode: 'plain',
            metadata: { path: '/private-owner-path', host: 'owner-host' },
            agentState: { requests: { secret: { tool: 'Bash', arguments: { command: 'private-owner-command' }, createdAt: 1 } } },
            storedContentMode: 'e2ee', encryptionKey, encryptionVariant: 'dataKey',
        });
        vi.mocked(axios.get).mockImplementation(async (url) => String(url).includes('/v2/sessions/')
            ? { status: 200, data: { session: createSessionRecordFixture({ id: 'shared-session', encryptionMode: 'e2ee',
                metadataLayoutVersion: 1, metadataVersion: 7, share: null,
                metadata: encodeBase64(encrypt(encryptionKey, 'dataKey', sharedMetadata)),
                ownerMetadata: privateTuple.ownerMetadata, agentState: privateTuple.agentState, agentStateVersion: 9,
            }) } }
            : { status: 404, data: {} });
        const getAccountEncryptionCurrentness = vi.fn(async () => {
            throw new Error('Shared editors must not read Account currentness');
        });
        client = new ApiSessionClient(token, createMockSession({ id: 'shared-session', encryptionMode: 'e2ee',
            encryptionKey, encryptionVariant: 'dataKey', metadataLayoutVersion: 1,
            metadata: { v: 1 }, metadataVersion: 1, agentState: null,
        }), {
            metadataAuthority: { kind: 'shared_editor' },
            getAccountEncryptionCurrentness,
            transport: {
                serverId: 'shared-editor-home',
                serverUrl: 'https://shared-home.example.test',
                createSessionSocketTransport: ({ sessionId, machineId }) => createSessionScopedSocketConnection({
                    token, sessionId, machineId, serverUrl: 'https://shared-home.example.test',
                }),
            },
        });

        const result = await client.readOpenedSessionStateSnapshot({ agentStateVersion: -1, sharedMetadataVersion: -1 });

        expect(result).toEqual({ agentState: null, sharedMetadata: { version: 7, value: sharedMetadata } });
        expect(JSON.stringify(result)).not.toContain('private-owner');
        expect(getAccountEncryptionCurrentness).not.toHaveBeenCalled();
        expect(readStoredCredentials).not.toHaveBeenCalled();
    });

    it('connects using the supplied exact Session socket without provisioning an AccessKey or opening Account updates', async () => {
        const token = 'scoped-runtime-token';
        const serverUrl = 'https://runner-home.example.test';
        const machineAdmissionTransport = vi.fn(async (request: Parameters<NonNullable<import('./sessionClient').ApiSessionClientOptions['machineAdmissionTransport']>>[0]) => ({
            status: 'accepted' as const, localId: request.localId,
        }));
        client = new ApiSessionClient(token, createMockSession({
            id: 'scoped-session', encryptionMode: 'plain', metadataLayoutVersion: 1,
            metadata: { v: 1 }, agentState: null,
        }), {
            metadataAuthority: { kind: 'shared_editor' },
            localMachineId: 'exact-machine',
            machineAdmissionTransport,
            transport: {
                serverId: 'runner-home',
                serverUrl,
                createSessionSocketTransport: ({ sessionId, machineId }) => {
                    const socket = createSessionScopedSocket({ token, sessionId, machineId, serverUrl });
                    return { socket, transport: createSocketTransportAdapter(socket) };
                },
            },
        });

        await vi.waitFor(() => expect(mockIo).toHaveBeenCalled());
        expect(client.getServerBinding()).toEqual({
            serverId: 'runner-home',
            serverUrl,
        });
        expect(client.getMachineAdmissionTransport()).toBe(machineAdmissionTransport);
        expect(mockIo.mock.calls).toHaveLength(1);
        expect(mockIo.mock.calls[0]).toEqual([
            serverUrl,
            expect.objectContaining({ auth: expect.objectContaining({
                token, sessionId: 'scoped-session', machineId: 'exact-machine', clientType: 'session-scoped',
            }) }),
        ]);
        expect(vi.mocked(axios.get).mock.calls.some(([url]) => String(url).includes('/access-keys/'))).toBe(false);
        expect(readStoredCredentials).not.toHaveBeenCalled();
    });

    it('delivers only exact destination Session invalidations to the installed Follow wake receiver', async () => {
        const token = 'scoped-runtime-token';
        const serverUrl = 'https://runner-home.example.test';
        const socket = createApiSessionSocketStub();
        const onSessionFollowInvalidated = vi.fn();
        const disposeSessionFollowWakeReceiver = vi.fn();
        const installSessionFollowWakeReceiver = vi.fn(() => disposeSessionFollowWakeReceiver);
        client = new ApiSessionClient(token, createMockSession({
            id: 'destination-session', encryptionMode: 'plain', metadataLayoutVersion: 1,
            metadata: { v: 1 }, agentState: null,
        }), {
            metadataAuthority: { kind: 'shared_editor' },
            localMachineId: 'exact-machine',
            onSessionFollowInvalidated,
            installSessionFollowWakeReceiver,
            transport: {
                serverId: 'runner-home',
                serverUrl,
                createSessionSocketTransport: () => ({
                    socket: socket as never,
                    transport: createSocketTransportAdapter(socket as never),
                }),
            },
        });

        await vi.waitFor(() => expect(socket.getHandler('session')).toBeTypeOf('function'));
        expect(installSessionFollowWakeReceiver).toHaveBeenCalledTimes(1);
        onSessionFollowInvalidated.mockClear();

        socket.trigger('session', {
            id: 'wake-exact',
            createdAt: 1,
            body: { t: 'session-changed', sessionId: 'destination-session' },
        });
        socket.trigger('session', {
            id: 'wake-wrong-session',
            createdAt: 2,
            body: { t: 'session-changed', sessionId: 'other-session' },
        });
        socket.trigger('session', {
            id: 'wake-malformed',
            createdAt: 3,
            body: { t: 'session-changed' },
        });

        expect(onSessionFollowInvalidated).toHaveBeenCalledTimes(1);
        await client.close();
        client = undefined;
        expect(disposeSessionFollowWakeReceiver).toHaveBeenCalledTimes(1);
    });

    it('keeps subsequent Session HTTP reads on the injected Home after the active process Home changes', async () => {
        const token = 'scoped-runtime-token';
        const serverUrl = 'https://runner-home.example.test';
        client = new ApiSessionClient(token, createMockSession({ id: 'scoped-session', encryptionMode: 'plain' }), {
            metadataAuthority: { kind: 'shared_editor' },
            transport: {
                serverId: 'runner-home',
                serverUrl,
                createSessionSocketTransport: ({ sessionId, machineId }) => {
                    const socket = createSessionScopedSocket({ token, sessionId, machineId, serverUrl });
                    return { socket, transport: createSocketTransportAdapter(socket) };
                },
            },
        });
        const release = publishServerHttpRuntimeOrigin('https://unrelated-home.example.test', 'https');
        try {
            await expect(client.readSessionTurnsProjection()).resolves.toBeNull();
            expect(axios.get).toHaveBeenCalledWith(
                `${serverUrl}/v1/sessions/scoped-session/turns`,
                expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${token}` }) }),
            );
        } finally {
            release();
        }
    });

    it('keeps worker projection reads local between connection and exact Session invalidations', async () => {
        const token = 'scoped-runtime-token';
        const serverUrl = 'https://runner-home.example.test';
        const socket = createApiSessionSocketStub({ connected: true });
        mockIo.mockImplementation(() => socket);
        const row = createSessionRecordFixture({ id: 'worker-session', encryptionMode: 'plain',
            metadata: '{"v":1}', metadataVersion: 0, metadataLayoutVersion: 1,
            share: { accessLevel: 'edit', canApprovePermissions: false },
            manager: { sessionId: 'lead' }, origin: { kind: 'run_step' },
            agentState: null, agentStateVersion: 0 });
        vi.mocked(axios.get).mockImplementation(async url => String(url) === `${serverUrl}/v2/sessions/worker-session`
            ? { status: 200, data: { session: row } } : { status: 404, data: {} });
        client = new ApiSessionClient(token, createMockSession({ id: 'worker-session', encryptionMode: 'plain',
            metadataLayoutVersion: 1, manager: { sessionId: 'lead' }, origin: { kind: 'run_step' } }), {
            metadataAuthority: { kind: 'shared_editor' },
            transport: { serverId: 'runner-home', serverUrl,
                createSessionSocketTransport: ({ sessionId, machineId }) => createSessionScopedSocketConnection({ token, sessionId, machineId, serverUrl }),
            },
        });
        const release = publishServerHttpRuntimeOrigin('https://unrelated-home.example.test', 'https');
        try {
            await vi.waitFor(() => expect(socket.getHandler('session')).toBeTypeOf('function'));
            // Connection recovery is itself an invalidation. Settle its snapshot
            // before checking that ordinary prompt reads use the accepted projection.
            await client.refreshSessionSnapshotFromServerRequired({ reason: 'explicit-drain' });
            const reads = vi.mocked(axios.get).mock.calls.length;
            await expect(client.readRolePromptOrganization()).resolves.toEqual({ manager: { sessionId: 'lead' }, origin: { kind: 'run_step' } });
            socket.trigger('session', { id: 'other-relation', createdAt: 1, body: { t: 'session-changed', sessionId: 'another-session' } });
            expect(vi.mocked(axios.get).mock.calls).toHaveLength(reads);
            delete row.manager;
            delete row.origin;
            socket.trigger('session', { id: 'relation-detached', createdAt: 1, body: { t: 'session-changed', sessionId: 'worker-session' } });
            await expect(client.readRolePromptOrganization()).resolves.toEqual({});
            expect(axios.get).toHaveBeenCalledWith(`${serverUrl}/v2/sessions/worker-session`,
                expect.objectContaining({ headers: expect.objectContaining({ Authorization: `Bearer ${token}` }) }));
            expect(readStoredCredentials).not.toHaveBeenCalled();
        } finally {
            release();
        }
    });

    it('keeps Follow source reads on the exact Session Home and rejects another Home credential', () => {
        const token = 'destination-home-token';
        const serverUrl = 'https://destination-home.example.test';
        client = new ApiSessionClient(token, createMockSession({ id: 'destination', encryptionMode: 'plain' }), {
            metadataAuthority: { kind: 'shared_editor' },
            transport: {
                serverId: 'destination-home',
                serverUrl,
                createSessionSocketTransport: ({ sessionId, machineId }) => {
                    const socket = createSessionScopedSocket({ token, sessionId, machineId, serverUrl });
                    return { socket, transport: createSocketTransportAdapter(socket) };
                },
            },
        });
        const release = publishServerHttpRuntimeOrigin('https://ambient-home.example.test', 'https');
        const wrongHomeRequest = vi.fn(() => resolveServerHttpBaseUrl());
        try {
            expect(client.runSessionFollowSourceRequest({
                credentials: { token },
                request: () => resolveServerHttpBaseUrl(),
            })).toBe(serverUrl);
            expect(() => client!.runSessionFollowSourceRequest({
                credentials: { token: 'another-home-token' },
                request: wrongHomeRequest,
            })).toThrow('do not belong to the destination Session Home');
            expect(wrongHomeRequest).not.toHaveBeenCalled();
        } finally {
            release();
        }
    });
});
