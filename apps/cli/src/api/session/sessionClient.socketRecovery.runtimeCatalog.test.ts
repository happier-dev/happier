import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Socket } from 'socket.io-client';
import type { ManagedConnectionTransport } from '@happier-dev/connection-supervisor';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApiSessionSocketStub, createSessionRuntimeActivityHomeStub, resolveApiSessionSocketDefaultAck } from '@/testkit/backends/apiSessionSocketHarness';
import { createAccountEncryptionCurrentnessFixture, createPlainSessionFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { createTestMetadata } from '@/testkit/backends/sessionMetadata';
import type { ClientToServerEvents, ServerToClientEvents } from '@/api/types';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { ApiSessionClient } from './sessionClient';
import { reloadConfiguration, configuration } from '@/configuration';
import { createSessionClientDurableMutationPersistenceContext } from './client/transport/mutations/sessionClientDurableMutationPersistence';
import { parseRuntimeSessionClientDurableMutation } from './client/transport/mutations/sessionClientDurableMutationPersistence';
import { createMcpActionEnablementWithServerFeatureAvailability,
    createMcpActionApprovalRequirement } from '@/mcp/server/createMcpActionEnablement';
import type { HappyMcpSessionClient } from '@/mcp/startHappyServer';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { SessionMetadataTuplePatchV1Schema, V2SessionByIdResponseSchema, type SessionRuntimeIssueV1, type SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';
import { buildUsageLimitIssueFingerprint } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';

describe('Session activity startup socket recovery', () => {
    const clients: ApiSessionClient[] = [];

    afterEach(async () => {
        await Promise.all(clients.splice(0).map((client) => client.close()));
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
        vi.unstubAllEnvs();
        reloadConfiguration();
    });

    function createClient(options: Readonly<{ durable?: boolean; sessionId?: string; workflowsEnabled?: boolean; quotaRecovery?: SessionUsageLimitRecoveryV1 }> = {}) {
        let connect!: () => void;
        let connected = new Promise<void>((resolve) => { connect = resolve; });
        let onDisconnected: Parameters<ManagedConnectionTransport['onDisconnected']>[0] | undefined;
        const home = createSessionRuntimeActivityHomeStub({ machineId: 'machine-1' });
        const socket = createApiSessionSocketStub({
            connected: false,
            emitWithAck: (event, payload) => home.answer(event, payload) ?? resolveApiSessionSocketDefaultAck(event, payload),
        });
        // Only HTTP and Socket.IO boundaries are replaced; the reconnect,
        // readiness, Activity and disposal owners all remain real.
        vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: {} });
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
            features: { automations: { enabled: true }, workflows: { enabled: options.workflowsEnabled === true },
                ...(options.quotaRecovery ? { sessions: { enabled: true, usageLimitRecovery: { enabled: true } } } : {}) }, capabilities: { session: {
                runtimeActivity: { protocolVersion: 2 }, pendingInput: { protocolVersion: 1 },
                publisherAuthority: { protocolVersion: 1 },
            } },
        }), { status: 200, headers: { 'content-type': 'application/json' } })));
        const metadata = createTestMetadata({ machineId: 'machine-1',
            ...(options.quotaRecovery ? { sessionUsageLimitRecoveryV1: options.quotaRecovery } : {}) });
        const fields = options.quotaRecovery ? buildSessionMetadataEnvelopeFields({
            credentials: { token: 'test-token', encryption: null }, accountEncryptionMode: 'plain',
            metadata, agentState: null, storedContentMode: 'plain',
        }) : null;
        let metadataWriteFailure: string | null = null;
        class ObservedSessionClient extends ApiSessionClient {
            override async updateMetadata(...args: Parameters<ApiSessionClient['updateMetadata']>) {
                try { await super.updateMetadata(...args); metadataWriteFailure = null; }
                catch (error) { metadataWriteFailure = error instanceof Error ? error.message : String(error); throw error; }
            }
        }
        const client = new ObservedSessionClient('test-token', createPlainSessionFixture({
            id: options.sessionId ?? 'socket-recovery', metadata,
            ...(fields ? { metadataLayoutVersion: 1, metadataVersion: 1,
                ownerMetadata: fields.ownerMetadataValue, ownerMetadataEnvelope: fields.ownerMetadata } : {}),
        }), {
            ...(options.quotaRecovery ? { localMachineId: 'machine-1' } : {}),
            transport: {
                serverId: 'socket-recovery-test',
                serverUrl: 'http://127.0.0.1:3000',
                createSessionSocketTransport: () => ({
                    // The canonical testkit implements the Socket.IO boundary.
                    socket: socket as unknown as Socket<ServerToClientEvents, ClientToServerEvents>,
                    transport: {
                        connect: async () => { await connected; socket.connected = true; },
                        disconnect: async () => { socket.connected = false; },
                        destroy: async () => {},
                        isConnected: () => socket.connected,
                        onConnected: () => () => {},
                        onDisconnected: (listener) => { onDisconnected = listener; return () => { onDisconnected = undefined; }; },
                        onError: () => () => {},
                    },
                }),
            },
            metadataAuthority: { kind: 'owner', credentials: { token: 'test-token', encryption: null } },
            durableMutationDeliveryInitiallyActive: options.durable === true,
            initialRegisteredSessionStateFieldMutations: options.durable ? [{
                v: 1, sessionId: options.sessionId ?? 'socket-recovery', mutationId: 'activity-online',
                fieldId: 'runtime.activity', deliveryClass: 'durable_best_effort', source: 'runtime', observedAt: Date.now(),
                op: { kind: 'set', value: { state: 'active', activeCount: 1 } },
            }] : [],
        });
        clients.push(client);
        return { client, socket, metadataWriteFailure: () => metadataWriteFailure, connect: () => connect(), goOffline: () => {
            connected = new Promise<void>((resolve) => { connect = resolve; });
            socket.connected = false;
            onDisconnected?.({ reason: 'transport close' });
        } };
    }

    it('wakes an admitted untimed quota wait through the real reconnect callback', async () => {
        const sessionId = 'c123456789012345678901234';
        const issue: SessionRuntimeIssueV1 = { v: 1, scope: 'primary_session', status: 'failed', source: 'usage_limit',
            code: 'usage_limit', agentId: 'codex', agentTurnId: 'quota-turn', occurredAt: 1_000,
            usageLimit: { v: 1, resetAtMs: null, retryAfterMs: null, quotaScope: 'account', recoverability: 'wait' } };
        const quotaRecovery: SessionUsageLimitRecoveryV1 = { v: 1, status: 'waiting',
            issueFingerprint: buildUsageLimitIssueFingerprint(issue), armedAtMs: 1_000,
            resetAtMs: null, nextCheckAtMs: null, attemptCount: 0, maxAttempts: 0,
            lastProbeError: null, resumePromptMode: 'off', selectedAuth: { kind: 'native' } };
        const { client, connect, goOffline, metadataWriteFailure } = createClient({ sessionId, quotaRecovery, durable: true });
        const fields = buildSessionMetadataEnvelopeFields({ credentials: { token: 'test-token', encryption: null },
            accountEncryptionMode: 'plain', metadata: client.getMetadataSnapshot()!, agentState: null, storedContentMode: 'plain' });
        let raw = createSessionRecordFixture({ id: sessionId, encryptionMode: 'plain', active: true,
            latestTurnStatus: 'failed', lastRuntimeIssue: issue, metadataLayoutVersion: 1, metadataVersion: 1,
            metadata: fields.sharedMetadata.ciphertext, ownerMetadata: fields.ownerMetadata, agentState: null, agentStateVersion: 0,
            share: null });
        V2SessionByIdResponseSchema.parse({ session: raw });
        let available = false;
        vi.mocked(axios.get).mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/account/encryption/currentness') return { status: 200, data: createAccountEncryptionCurrentnessFixture() };
            if (path === `/v2/sessions/${sessionId}`) {
                if (!available) throw new Error('Session read unavailable');
                return { status: 200, data: { session: raw } };
            }
            return { status: 200, data: {} };
        });
        vi.spyOn(axios, 'patch').mockImplementation(async (_url, body: unknown) => {
            const patch = SessionMetadataTuplePatchV1Schema.parse(body);
            if (patch.mode !== 'owner') throw new Error('Expected current owner tuple edit');
            raw = { ...raw, metadata: patch.sharedMetadata.ciphertext, ownerMetadata: patch.ownerMetadata,
                metadataVersion: raw.metadataVersion + 1, agentState: patch.agentState.ciphertext,
                agentStateVersion: patch.agentState.expectedVersion + 1 };
            return { status: 200, data: { success: true, metadataLayoutVersion: 1,
                sharedMetadata: { version: raw.metadataVersion }, agentState: { version: raw.agentStateVersion } } };
        });
        let nativeChecks = 0;
        client.setSessionRuntimeControls({ checkUsageLimitRecoveryNow: async () => {
            nativeChecks += 1;
            return { ok: true, status: 'ready' };
        } });
        connect();
        await client.claimCurrentSessionPublisherAuthorityForStartup();
        await vi.waitFor(() => expect(metadataWriteFailure()).toBe('Session read unavailable'));
        expect(client.getMetadataSnapshot()?.sessionUsageLimitRecoveryV1).toMatchObject({ status: 'waiting', nextCheckAtMs: null });
        const checksBeforeReconnect = nativeChecks;
        goOffline();
        available = true;
        connect();
        await client.claimCurrentSessionPublisherAuthorityForStartup();
        await vi.waitFor(() => expect({ nativeChecks, metadataWriteFailure: metadataWriteFailure() })
            .toEqual({ nativeChecks: checksBeforeReconnect + 1, metadataWriteFailure: null }));
        await vi.waitFor(() => expect(client.getMetadataSnapshot()?.sessionUsageLimitRecoveryV1)
            .toMatchObject({ status: 'paused', nextCheckAtMs: null }));
        expect(nativeChecks).toBe(checksBeforeReconnect + 1);
    });

    it('admits Session agent workflow reads from the connected Home projection and retains mutation approval', async () => {
        const { client, connect, goOffline } = createClient({ workflowsEnabled: true });
        const agentClient: HappyMcpSessionClient = client;
        const actionSettingsProvider = {
            getActionsSettings: () => normalizeActionsSettingsV1({
                v: 1, actions: { 'workflow.definition.create': { approvalRequiredSurfaces: ['agent'] } },
            }),
        };
        const policy = createMcpActionEnablementWithServerFeatureAvailability({
            actionSettingsProvider, surface: 'agent', hasAuthenticatedRuntime: true, authorityScope: 'session',
            readServerFeaturesSnapshot: () => agentClient.getServerFeaturesSnapshot?.(), env: {},
        });
        expect(policy('workflow.definition.list')).toBe(false);
        connect();
        await vi.waitFor(() => expect(policy('workflow.definition.list')).toBe(true));
        for (const id of ['workflow.definition.get', 'workflow.run.list', 'workflow.starters.list',
            'workflow.starters.resolve', 'boards.list'] as const) expect(policy(id), id).toBe(true);
        const requiresApproval = createMcpActionApprovalRequirement({ actionSettingsProvider, surface: 'agent' });
        expect(requiresApproval('workflow.definition.create', { surface: 'agent' })).toBe(true);
        goOffline();
        expect(policy('workflow.definition.list')).toBe(false);
    });

    it('keeps an Activity write pending beyond a transport attempt budget and applies it on recovery', async () => {
        vi.useFakeTimers();
        const { client, socket, connect } = createClient();
        let outcome = 'pending';
        const write = client.updateRuntimeActivityProjection({
            runtimeActivityState: 'active', runtimeActivityActiveCount: 1,
        });
        void write.then(() => { outcome = 'applied'; }, () => { outcome = 'rejected'; });
        await vi.advanceTimersByTimeAsync(resolveSessionControlSocketConnectTimeoutMs() + 1);
        expect(outcome).toBe('pending');
        expect(socket.emitWithAck.mock.calls.some(([event]) => event === 'session-runtime-activity-snapshot')).toBe(false);
        connect();
        await vi.advanceTimersByTimeAsync(0);
        await write;
        expect(outcome).toBe('applied');
        expect(socket.emitWithAck).toHaveBeenCalledWith('session-runtime-activity-snapshot', expect.objectContaining({
            sessionId: 'socket-recovery', snapshot: { state: 'active', activeCount: 1 },
        }));
    });

    it('cancels an offline Activity waiter when its Session is closed', async () => {
        const { client } = createClient();
        const write = client.updateRuntimeActivityProjection({
            runtimeActivityState: 'unknown', runtimeActivityActiveCount: 0,
        });
        const rejected = expect(write).rejects.toMatchObject({ code: 'session_closed', retryable: false });
        await client.close();
        clients.splice(clients.indexOf(client), 1);
        await rejected;
    });

    it('closes offline durable Activity delivery while retaining its journal for recovery', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1);
        const taskHome = await mkdtemp(join(tmpdir(), 'happier-gq-offline-close-'));
        vi.stubEnv('HAPPIER_HOME_DIR', taskHome);
        reloadConfiguration();
        const sessionId = 'durable-offline-close';
        const { client, socket, connect, goOffline } = createClient({ durable: true, sessionId });
        connect();
        await expect(client.claimCurrentSessionPublisherAuthorityForStartup()).resolves.toEqual({ status: 'claimed' });
        goOffline();
        now.mockReturnValue(2);
        const mutation = {
            v: 1 as const, sessionId, mutationId: 'activity-offline', fieldId: 'runtime.activity' as const,
            deliveryClass: 'durable_best_effort' as const, source: 'runtime' as const, observedAt: 2,
            op: { kind: 'set' as const, value: { state: 'unknown', activeCount: 0 } },
        };
        const write = client.enqueueRegisteredSessionStateFieldMutation(mutation);
        // Observe real admission on disk before asking close to drain it.
        const persistence = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configuration.activeServerDir, custody: 'runtime', sessionId,
            parseQueuedMutation: parseRuntimeSessionClientDurableMutation,
        });
        await expect.poll(async () => {
            try { return JSON.parse(await readFile(persistence.paths.queuePath, 'utf8')); } catch { return null; }
        }).toMatchObject({ mutations: [{ payload: {
            sessionId, fieldId: 'runtime.activity', observedAt: 2, op: mutation.op,
        } }] });
        let writeOutcome = 'pending';
        void write.then(() => { writeOutcome = 'applied'; }, () => { writeOutcome = 'cancelled'; });
        let closeOutcome = 'pending';
        const closing = client.close();
        void closing.then(() => { closeOutcome = 'closed'; }, () => { closeOutcome = 'failed'; });
        try {
            await expect.poll(() => closeOutcome).toBe('closed');
            expect(writeOutcome).toBe('cancelled');
            const journal = JSON.parse(await readFile(persistence.paths.queuePath, 'utf8')) as { mutations: unknown[] };
            expect(journal.mutations).toEqual(expect.arrayContaining([expect.objectContaining({
                payload: expect.objectContaining({ sessionId, fieldId: 'runtime.activity', observedAt: 2, op: mutation.op }),
            })]));
            expect(socket.connected).toBe(false);
        } finally {
            // Let an intentionally failing RED finish its owned offline waiter.
            connect();
            await closing;
            clients.splice(clients.indexOf(client), 1);
        }
    });
});
