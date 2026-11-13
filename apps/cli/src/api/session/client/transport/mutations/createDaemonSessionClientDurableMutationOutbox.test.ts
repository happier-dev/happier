import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import axios from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/ui/logger';
import { createDaemonSessionMutationCustody } from '@/daemon/connectedServices/usageLimitRecovery/createDaemonUsageLimitRecoveryMutationCustody';
import { createAccountEncryptionCurrentnessFixture, createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';
import { SessionMetadataOwnerMigrationPatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { createAccountScopedCryptoMaterialSnapshotV1, convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1, SessionMetadataTuplePatchV1Schema, TranscriptRawRecordV1Schema } from '@happier-dev/protocol';
import { SessionStoredMessageContentSchema } from '@happier-dev/protocol/sessions/messages/sessionStoredMessageContent';
import { readSessionWorkStateV1FromMetadata, type SessionWorkStateV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateV1';
import { buildSessionMetadataEnvelopeFields } from '@/session/metadata/buildSessionMetadataEnvelopeCreateFields';
import { openSessionStoredContent, tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import type { StoredCredentials } from '@/persistence';

const { configurationMock } = vi.hoisted(() => ({
    configurationMock: {
        activeServerDir: '',
        apiServerUrl: 'http://server.example.test',
    },
}));

vi.mock('@/configuration', () => ({ configuration: configurationMock }));
vi.mock('axios');

import {
    createDaemonSessionClientDurableMutationOutbox,
    type ExactDaemonSessionTurnEndMutationV1,
} from './createDaemonSessionClientDurableMutationOutbox';
import {
    resetSessionClientDurableMutationOutboxStateForTests,
} from './createSessionClientDurableMutationOutbox';
import {
    createRegisteredSessionStateFieldMutation,
    createTranscriptMessageAppendMutation,
    type DaemonUsageLimitRecoveryFieldMutation,
    type DaemonWorkStateFieldMutation,
    type TranscriptMessageAppendMutationV1,
} from './sessionClientDurableMutationTypes';
import {
    createSessionClientDurableMutationPersistenceContext,
    parseDaemonSessionClientDurableMutation,
    resolveSessionClientDurableMutationJournalPaths,
    saveSessionClientDurableMutationOutbox,
} from './sessionClientDurableMutationPersistence';

describe('daemon session client durable mutation outbox', () => {
    beforeEach(async () => {
        configurationMock.activeServerDir = await mkdtemp(join(tmpdir(), 'happier-daemon-session-mutations-'));
        vi.mocked(axios.post).mockReset();
        vi.mocked(axios.post).mockRejectedValue(new Error('http unavailable'));
    });

    afterEach(async () => {
        await resetSessionClientDurableMutationOutboxStateForTests();
        await rm(configurationMock.activeServerDir, { recursive: true, force: true });
    });

    it.each([true, false])('uses only an admitted daemon transcript writer without a socket handle (writer: %s)', async (hasWriter) => {
        let deliveredLocalId: string | null = null;
        const outbox = createDaemonSessionClientDurableMutationOutbox({
            token: 'token', sessionId: 'daemon-transcript',
            enableExactTurnDelivery: false,
            getSocket: () => null,
            requestReconnect: () => {},
            // The transport callback represents the Home commit; shared handle
            // selection, transcript admission and the filesystem journal are real.
            ...(hasWriter ? { deliverTranscriptMessage: async (mutation: TranscriptMessageAppendMutationV1) => {
                deliveredLocalId = mutation.localId; return true;
            } } : {}),
        });
        try {
            await expect(outbox.enqueueTranscriptMessage(createTranscriptMessageAppendMutation({
                sessionId: 'daemon-transcript', localId: 'native-answer',
                content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'observed answer' } } },
                messageRole: 'agent', provenance: { kind: 'non_dependent', source: 'external' },
            }))).resolves.toMatchObject({ persisted: true, delivered: hasWriter });
            expect(deliveredLocalId).toBe(hasWriter ? 'native-answer' : null);
        } finally { await outbox.close(); }
    });

    it('acknowledges daemon work-state only after the registered field write is visible to readers', async () => {
        let acknowledge!: () => void;
        let started!: () => void;
        const deliveryStarted = new Promise<void>(resolve => { started = resolve; });
        const delivered = new Promise<void>(resolve => { acknowledge = resolve; });
        let visibleWorkState: unknown = { items: [{ kind: 'goal', title: 'Old goal' }] };
        const deliverWorkState = async (mutation: DaemonWorkStateFieldMutation) => {
            started();
            await delivered;
            visibleWorkState = mutation.op.kind === 'set' ? mutation.op.value : null;
            return true;
        };
        const outbox = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverWorkState,
        });
        const workState = createRegisteredSessionStateFieldMutation({
            sessionId: 's1',
            fieldId: 'runtime.workState',
            source: 'daemon',
            observedAt: 100,
            op: { kind: 'set', value: { v: 1, backendId: 'codex', updatedAt: 100, items: [] } },
        }) as DaemonWorkStateFieldMutation;
        let settled = false;
        const staged = outbox.enqueueWorkState(workState).then(() => { settled = true; });
        await deliveryStarted;
        const paths = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
        });
        const persisted = JSON.parse(await readFile(paths.queuePath, 'utf8')) as { mutations: unknown[] };
        expect(persisted.mutations).toEqual([expect.objectContaining({ payload: workState })]);
        try {
            expect(settled).toBe(false);
        } finally {
            acknowledge();
            await staged;
            await outbox.close();
        }
        expect(visibleWorkState).toEqual(workState.op.kind === 'set' ? workState.op.value : null);
    });

    it('keeps Goal custody pending until the real metadata writer commits', async () => {
        const rawSession = createSessionRecordFixture({ id: 'goal-custody', encryptionMode: 'plain', metadata: '{}' });
        const custody = createDaemonSessionMutationCustody({ credentials: { token: 'token', encryption: null } });
        let acknowledge!: () => void;
        let started!: () => void;
        const patchStarted = new Promise<void>(resolve => { started = resolve; });
        const patchAcknowledged = new Promise<void>(resolve => { acknowledge = resolve; });
        let committedMetadata: unknown = null;
        const diagnostics = vi.spyOn(logger, 'debug');
        // Only HTTP is replaced; custody, journal, field codecs and metadata CAS are real.
        vi.mocked(axios.get).mockResolvedValue({ status: 200, data: createAccountEncryptionCurrentnessFixture() });
        vi.mocked(axios.patch).mockImplementation(async (_url, body) => {
            started();
            await patchAcknowledged;
            const patch = SessionMetadataOwnerMigrationPatchV1Schema.parse(body);
            if (patch.target.ownerMetadata.t !== 'plain') throw new Error('Expected keyless Plain owner metadata');
            committedMetadata = projectSessionOwnerCompatibilityViewV1({
                sharedMetadata: JSON.parse(patch.target.sharedMetadata.ciphertext), ownerMetadata: patch.target.ownerMetadata.v,
            });
            return { status: 200, data: SessionMetadataTuplePatchSuccessV1Schema.parse({
                success: true, metadataLayoutVersion: 1, sharedMetadata: { version: 2 }, agentState: { version: 1 },
            }) };
        });
        const mutation = createRegisteredSessionStateFieldMutation({
            sessionId: rawSession.id, fieldId: 'runtime.workState', source: 'daemon', observedAt: 100,
            op: { kind: 'set', value: { v: 1, backendId: 'codex', updatedAt: 100, items: [], primaryItemId: null } },
        }) as DaemonWorkStateFieldMutation;
        let settled = false;
        const staged = custody.stageWorkState({ mutation, rawSession }).then(() => { settled = true; });
        try {
            await vi.waitFor(() => expect({ patches: vi.mocked(axios.patch).mock.calls.length,
                failures: diagnostics.mock.calls.filter(call => String(call[0]).includes('delivery failed')) })
                .toEqual({ patches: 1, failures: [] }));
            await patchStarted;
            expect(settled).toBe(false);
            acknowledge();
            await vi.waitFor(() => expect({ settled,
                failures: diagnostics.mock.calls.filter(call => String(call[0]).includes('delivery failed')) })
                .toEqual({ settled: true, failures: [] }));
            await staged;
            expect(committedMetadata).toMatchObject({ sessionWorkStateV1: { items: [] } });
        } finally {
            acknowledge();
            await custody.close();
            diagnostics.mockRestore();
        }
    });

    it.each(['plain', 'e2ee'] as const)('publishes only committed effective daemon Goal changes through transcript custody (%s)', async mode => {
        const secret = new Uint8Array(32).fill(4);
        const credentials: StoredCredentials = { token: 'token', encryption: mode === 'plain' ? null : { type: 'legacy', secret } };
        const context = mode === 'plain' ? { mode, ctx: null } as const
            : { mode, ctx: { encryptionKey: secret, encryptionVariant: 'legacy' as const } };
        const tuple = buildSessionMetadataEnvelopeFields({ credentials, accountEncryptionMode: mode,
            metadata: {}, agentState: null,
            ...(mode === 'plain' ? { storedContentMode: mode } : { storedContentMode: mode, encryptionKey: secret, encryptionVariant: 'legacy' }) });
        const row = createSessionRecordFixture({ id: 'caaaaaaaaaaaaaaaaaaaaaaaa', encryptionMode: mode,
            metadataLayoutVersion: 1, metadata: tuple.sharedMetadata.ciphertext, metadataVersion: 1,
            ownerMetadata: tuple.ownerMetadata, agentState: tuple.agentState, agentStateVersion: 1, share: null });
        const material = mode === 'e2ee' ? createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: mode,
            material: { type: 'legacy', secret } }) : null;
        const currentness = createAccountEncryptionCurrentnessFixture({ mode,
            contentKeyFingerprint: material ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint) : null });
        let sessionReadAvailable = false;
        vi.mocked(axios.get).mockImplementation(async url => {
            if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200, data: currentness };
            if (!sessionReadAvailable) throw new Error('Session reads unavailable after the successful Goal commit');
            return { status: 200, data: { session: row } };
        });
        let commitMode: 'success' | 'conflict_equal' | 'refused' = 'success';
        let refusedObserved = false;
        vi.mocked(axios.patch).mockImplementation(async (_url, body) => {
            const patch = SessionMetadataTuplePatchV1Schema.parse(body);
            if (patch.mode !== 'owner') throw new Error('Expected owner tuple patch');
            if (commitMode === 'refused') { refusedObserved = true; return { status: 409, data: { code: 'session_publisher_authority_lost' } }; }
            row.metadata = patch.sharedMetadata.ciphertext;
            row.ownerMetadata = patch.ownerMetadata;
            row.metadataVersion += 1;
            if (patch.agentState) { row.agentState = patch.agentState.ciphertext; row.agentStateVersion = (row.agentStateVersion ?? 0) + 1; }
            if (commitMode === 'conflict_equal') {
                commitMode = 'success';
                return { status: 409, data: { code: 'session_metadata_version_conflict', metadataLayoutVersion: 1,
                    sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } } };
            }
            return { status: 200, data: SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
                sharedMetadata: { version: row.metadataVersion }, agentState: { version: row.agentStateVersion } }) };
        });
        const originals: { localId: string; content: unknown; goal: SessionWorkStateV1 | null }[] = [];
        const attempts: string[] = [];
        let failAppend = true;
        vi.mocked(axios.post).mockImplementation(async (url, body) => {
            if (!String(url).endsWith(`/v2/sessions/${row.id}/messages`)) throw new Error(`Unexpected HTTP path: ${url}`);
            const request = body as { localId: string; content: unknown; messageRole: string };
            attempts.push(request.localId);
            if (failAppend) { failAppend = false; throw new Error('Transient append transport failure'); }
            const content = SessionStoredMessageContentSchema.parse(request.content);
            const opened = TranscriptRawRecordV1Schema.parse(openSessionStoredContent({ ...context, content }));
            originals.push({ localId: request.localId, content: opened,
                goal: readSessionWorkStateV1FromMetadata(tryDecryptSessionOwnerMetadataView({ credentials, rawSession: row,
                    accountEncryptionMode: mode, recipientEnvelopeReadiness: currentness.recipientEnvelopeReadiness })) });
            expect(request.messageRole).toBe('event');
            expect(request.localId).toMatch(/^goal-changed:/);
            return { status: 200, data: { didWrite: true, message: { id: `message-${originals.length}`, localId: request.localId,
                seq: originals.length, createdAt: 1, updatedAt: 1, content } } };
        });
        const custody = createDaemonSessionMutationCustody({ credentials });
        const goal: SessionWorkStateV1 = { v: 1, backendId: 'codex', updatedAt: 100, items: [{ id: 'goal', kind: 'goal',
            origin: 'happier', status: 'active', title: 'Private daemon objective', updatedAt: 100 }] };
        const stage = (value: SessionWorkStateV1 | null, signal?: AbortSignal) => custody.stageWorkState({ rawSession: { ...row }, signal,
            mutation: createRegisteredSessionStateFieldMutation({ sessionId: row.id, fieldId: 'runtime.workState', source: 'daemon',
                observedAt: Date.now(), op: value ? { kind: 'set', value } : { kind: 'clear' } }) as DaemonWorkStateFieldMutation });
        try {
            await stage(goal);
            await vi.waitFor(() => expect(originals).toHaveLength(1), { timeout: 10_000 });
            expect(attempts.length).toBeGreaterThan(1);
            expect(new Set(attempts).size).toBe(1);
            expect(originals[0]?.goal?.items).toMatchObject([{ title: 'Private daemon objective' }]);
            await stage(goal);
            await stage({ ...goal, updatedAt: 101, items: [{ ...goal.items[0]!, progress: 0.5, tokensUsed: 10, updatedAt: 101 }] });
            expect(originals).toHaveLength(1);
            // A competing writer applies the exact requested change before our CAS.
            // The final retry sees an equal Goal and must not publish the attempted transition.
            sessionReadAvailable = true;
            commitMode = 'conflict_equal';
            await stage({ ...goal, items: [{ ...goal.items[0]!, title: 'Concurrent objective' }] });
            expect(originals).toHaveLength(1);
            await stage(null);
            await vi.waitFor(() => expect(originals).toHaveLength(2));
            expect(originals[1]?.goal).toBeNull();
            await stage(null);
            expect(originals).toHaveLength(2);
            for (const original of originals) expect(original.content).toEqual({ role: 'agent',
                content: { type: 'event', id: original.localId, data: { type: 'goal-changed' } } });
            expect(JSON.stringify(originals.map(original => original.content))).not.toContain('objective');

            commitMode = 'refused';
            const refused = new AbortController();
            const pending = stage(goal, refused.signal).catch((error: unknown) => error);
            await vi.waitFor(() => expect(refusedObserved).toBe(true));
            // Drain asynchronous delivery after the observed refused HTTP response.
            await new Promise<void>(resolve => setImmediate(resolve));
            refused.abort();
            await expect(pending).resolves.toMatchObject({ name: 'AbortError' });
            expect(originals).toHaveLength(2);
        } finally { await custody.close(); }
    });

    it('detaches a cancelled Goal caller during delivery while retaining custody and another waiter for replay', async () => {
        let releaseDelivery!: () => void;
        let markDeliveryStarted!: () => void;
        const heldDelivery = new Promise<void>(resolve => { releaseDelivery = resolve; });
        const deliveryStarted = new Promise<void>(resolve => { markDeliveryStarted = resolve; });
        let deliveryAvailable = false;
        let visibleWorkState: unknown = null;
        const outbox = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 'cancelled-goal',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverWorkState: async mutation => {
                markDeliveryStarted();
                await heldDelivery;
                if (!deliveryAvailable) return false;
                visibleWorkState = mutation.op.kind === 'set' ? mutation.op.value : null;
                return true;
            },
        });
        const mutation = createRegisteredSessionStateFieldMutation({
            sessionId: 'cancelled-goal', fieldId: 'runtime.workState', source: 'daemon', observedAt: 100,
            op: { kind: 'set', value: { v: 1, backendId: 'codex', updatedAt: 100, items: [] } },
        }) as DaemonWorkStateFieldMutation;
        const caller = new AbortController();
        let callerDisposition = 'pending';
        const cancelled = outbox.enqueueWorkState(mutation, { signal: caller.signal }).then(
            () => { callerDisposition = 'fulfilled'; },
            (error: unknown) => { callerDisposition = error instanceof Error ? error.name : 'unknown'; },
        );
        let observerSettled = false;
        let observer: Promise<void> | undefined;
        const paths = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir: configurationMock.activeServerDir, custody: 'daemon', sessionId: mutation.sessionId,
        });
        const readCustody = async () => JSON.parse(await readFile(paths.queuePath, 'utf8')) as { mutations: unknown[] };
        try {
            await deliveryStarted;
            expect((await readCustody()).mutations).toEqual([expect.objectContaining({ payload: mutation })]);
            observer = outbox.enqueueWorkState(mutation).then(() => { observerSettled = true; });
            caller.abort();
            // Let the public promise settle without releasing the external delivery boundary.
            for (let turn = 0; turn < 20; turn++) await new Promise<void>(resolve => setImmediate(resolve));
            expect(callerDisposition, 'Caller abort must settle before held delivery is released').toBe('AbortError');
            expect(observerSettled).toBe(false);
            expect((await readCustody()).mutations).toHaveLength(1);

            releaseDelivery();
            await outbox.flush('flush');
            expect(observerSettled).toBe(false);
            expect((await readCustody()).mutations).toHaveLength(1);
            deliveryAvailable = true;
            await outbox.flush('connect');
            await observer;
            expect(visibleWorkState).toEqual(mutation.op.kind === 'set' ? mutation.op.value : null);
            await expect(readFile(paths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            deliveryAvailable = true;
            releaseDelivery();
            await outbox.flush('flush');
            await Promise.all([cancelled, observer]);
            await outbox.close();
        }
    });

    it('durably accepts an exact turn end only in the daemon journal', async () => {
        const outbox = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({ connected: false, emit: () => undefined }),
            requestReconnect: () => undefined,
        });
        const exact: ExactDaemonSessionTurnEndMutationV1 = {
            v: 1,
            sessionId: 's1',
            mutationId: 'end-turn-1',
            action: 'end_session',
            turnId: 'turn-1',
            observedAt: 100,
        };

        await outbox.enqueueExactTurnEnd(exact);

        const paths = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
        });
        const persisted = JSON.parse(await readFile(paths.queuePath, 'utf8')) as {
            mutations: Array<{ mutationId?: string; payload?: { turnId?: string } }>;
        };
        expect(persisted.mutations).toEqual([
            expect.objectContaining({
                mutationId: 'end-turn-1',
                payload: expect.objectContaining({ turnId: 'turn-1' }),
            }),
        ]);
        const runtimePaths = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'runtime',
            sessionId: 's1',
        });
        await expect(readFile(runtimePaths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await outbox.close();
    });

    it('parks daemon exact turn ends for the released server and replays them after upgrade', async () => {
        const sessionId = 'released-server-daemon-turn';
        const exact: ExactDaemonSessionTurnEndMutationV1 = {
            v: 1,
            sessionId,
            mutationId: 'released-server-exact-end',
            action: 'end_session',
            turnId: 'turn-1',
            observedAt: 100,
        };
        let serverMode: 'released_server_v0_2_1' | 'session_sync_v2_pending_input_v1' =
            'released_server_v0_2_1';
        const deliveredMutationIds: string[] = [];
        const requestReconnect = vi.fn();
        const createOutbox = () => createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId,
            getSessionTurnServerContractMode: () => serverMode,
            getSocket: () => ({
                connected: true,
                emit: () => undefined,
                emitWithAck: async (_event, value) => {
                    const mutation = value as ExactDaemonSessionTurnEndMutationV1;
                    deliveredMutationIds.push(mutation.mutationId);
                    return {
                        result: 'success',
                        receipt: {
                            ...mutation,
                            decision: 'applied',
                            appliedAt: mutation.observedAt + 1,
                        },
                    };
                },
            }),
            requestReconnect,
        });
        const outbox = createOutbox();

        await outbox.enqueueExactTurnEnd(exact);

        const paths = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId,
        });
        const parked = JSON.parse(await readFile(paths.queuePath, 'utf8')) as {
            mutations: Array<{ mutationId: string; attempts: number }>;
        };
        expect(parked.mutations).toEqual([
            expect.objectContaining({ mutationId: exact.mutationId, attempts: 0 }),
        ]);
        expect(deliveredMutationIds).toEqual([]);
        expect(vi.mocked(axios.post)).not.toHaveBeenCalled();
        expect(requestReconnect).not.toHaveBeenCalled();
        await expect(outbox.close()).resolves.toBeUndefined();

        serverMode = 'session_sync_v2_pending_input_v1';
        const restarted = createOutbox();
        await restarted.awaitReady();
        await restarted.flush('connect');

        expect(deliveredMutationIds).toEqual([exact.mutationId]);
        await expect(readFile(paths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await restarted.close();
    });

    it('reports a persistently blocking authoritative mutation once without changing retry custody', async () => {
        const previousMaxAttempts = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
        const previousBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
        const previousJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
        const infoFileSpy = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const exact: ExactDaemonSessionTurnEndMutationV1 = {
            v: 1,
            sessionId: 's1',
            mutationId: 'persistently-blocked-end',
            action: 'end_session',
            turnId: 'turn-blocked',
            observedAt: 100,
        };
        const following = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'following-transcript-row',
            messageRole: 'event',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'event' } } },
            createdAt: 101,
            updatedAt: 101,
            provenance: { kind: 'non_dependent', source: 'background' },
        });
        const persistenceContext = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
            parseQueuedMutation: parseDaemonSessionClientDurableMutation,
        });
        await saveSessionClientDurableMutationOutbox('s1', [
            {
                kind: 'session_turn_mutation',
                mutationId: exact.mutationId,
                payload: exact,
                createdAt: exact.observedAt,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'transcript_message_append',
                mutationId: following.mutationId,
                payload: following,
                createdAt: following.createdAt,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ], persistenceContext);
        const outbox = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({ connected: false, emit: () => undefined }),
            requestReconnect: () => undefined,
        });

        try {
            await outbox.awaitReady();
            await outbox.flush('flush');
            await outbox.flush('flush');

            expect(infoFileSpy.mock.calls.filter(([message]) =>
                message === '[API] Authoritative session mutation remains queued and is blocking later mutations')).toHaveLength(1);
            expect(infoFileSpy).toHaveBeenCalledWith(
                '[API] Authoritative session mutation remains queued and is blocking later mutations',
                expect.objectContaining({
                    sessionId: 's1',
                    mutationId: exact.mutationId,
                    mutationKind: 'session_turn_mutation',
                    action: 'end_session',
                    turnId: 'turn-blocked',
                    attempts: 1,
                    lastAttemptReason: 'delivery_not_confirmed',
                    blockedMutationCount: 1,
                    blockedMutationKinds: { transcript_message_append: 1 },
                }),
            );
            const persisted = JSON.parse(await readFile(persistenceContext.paths.queuePath, 'utf8')) as {
                mutations: Array<{ mutationId?: string; attempts?: number }>;
            };
            expect(persisted.mutations).toEqual([
                expect.objectContaining({ mutationId: exact.mutationId, attempts: 2 }),
                expect.objectContaining({ mutationId: following.mutationId, attempts: 0 }),
            ]);
        } finally {
            infoFileSpy.mockRestore();
            await outbox.close();
            if (previousMaxAttempts === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = previousMaxAttempts;
            if (previousBaseRetryMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = previousBaseRetryMs;
            if (previousJitterMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = previousJitterMs;
        }
    });

    it('reports a persistently blocking durable-required usage-limit recovery field once', async () => {
        const previousMaxAttempts = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
        const previousBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
        const previousJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '60000';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
        const infoFileSpy = vi.spyOn(logger, 'infoFile').mockImplementation(() => {});
        const recoveryField = createRegisteredSessionStateFieldMutation({
            sessionId: 's1',
            fieldId: 'runtime.usageLimitRecovery',
            source: 'daemon',
            deliveryClass: 'durable_required',
            observedAt: 100,
            op: {
                kind: 'set',
                value: {
                    v: 1,
                    status: 'cancelled',
                    resumePromptMode: 'standard',
                    issueFingerprint: 'usage-limit:codex:turn-1:1:2',
                    armedAtMs: 1,
                    resetAtMs: 2,
                    nextCheckAtMs: null,
                    attemptCount: 1,
                    maxAttempts: 3,
                    lastProbeError: null,
                    selectedAuth: { kind: 'native', serviceId: 'openai-codex' },
                },
            },
        }) as DaemonUsageLimitRecoveryFieldMutation;
        const following = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'blocked-behind-usage-limit-recovery',
            messageRole: 'event',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'event' } } },
            createdAt: 101,
            updatedAt: 101,
            provenance: { kind: 'non_dependent', source: 'background' },
        });
        const persistenceContext = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
            parseQueuedMutation: parseDaemonSessionClientDurableMutation,
        });
        await saveSessionClientDurableMutationOutbox('s1', [
            {
                kind: 'registered_session_state_field',
                mutationId: recoveryField.mutationId,
                payload: recoveryField,
                createdAt: recoveryField.observedAt,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'transcript_message_append',
                mutationId: following.mutationId,
                payload: following,
                createdAt: following.createdAt,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ], persistenceContext);
        const outbox = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverUsageLimitRecovery: async () => false,
        });

        try {
            await outbox.awaitReady();
            await outbox.flush('flush');
            await outbox.flush('flush');

            expect(infoFileSpy).toHaveBeenCalledWith(
                '[API] Authoritative session mutation remains queued and is blocking later mutations',
                expect.objectContaining({
                    sessionId: 's1',
                    mutationId: recoveryField.mutationId,
                    mutationKind: 'registered_session_state_field',
                    blockedMutationCount: 1,
                    blockedMutationKinds: { transcript_message_append: 1 },
                }),
            );
        } finally {
            infoFileSpy.mockRestore();
            await outbox.close();
            if (previousMaxAttempts === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = previousMaxAttempts;
            if (previousBaseRetryMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = previousBaseRetryMs;
            if (previousJitterMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = previousJitterMs;
        }
    });

    it('retains a daemon transcript event after HTTP delivery failure and replays it once after restart', async () => {
        const failedDelivery = vi.fn(async () => {
            throw new Error('http unavailable');
        });
        const first = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverTranscriptMessage: failedDelivery,
        });
        const mutation = createTranscriptMessageAppendMutation({
            sessionId: 's1',
            localId: 'connected-service-account-switch:one',
            messageRole: 'event',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'event' } } },
            createdAt: 100,
            updatedAt: 100,
            provenance: { kind: 'non_dependent', source: 'background' },
        });

        await expect(first.enqueueTranscriptMessage(mutation)).resolves.toEqual({
            persisted: true,
            delivered: false,
            localId: mutation.localId,
        });
        const paths = resolveSessionClientDurableMutationJournalPaths({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
        });
        await expect(readFile(paths.queuePath, 'utf8')).resolves.toContain(mutation.mutationId);
        await first.close();

        const replayed = vi.fn(async () => true);
        const restarted = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverTranscriptMessage: replayed,
        });
        await restarted.awaitReady();
        await restarted.flush('startup');

        expect(replayed).toHaveBeenCalledTimes(1);
        expect(replayed).toHaveBeenCalledWith(mutation);
        await expect(readFile(paths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await restarted.close();
    });

    it('rejects casted broad or decorated terminal rows before persistence', async () => {
        const outbox = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({ connected: false, emit: () => undefined }),
            requestReconnect: () => undefined,
        });
        const invalidRows = [
            {
                v: 1,
                sessionId: 's1',
                mutationId: 'broad',
                action: 'end_session',
                observedAt: 100,
            },
            {
                v: 1,
                sessionId: 's1',
                mutationId: 'decorated',
                action: 'end_session',
                turnId: 'turn-1',
                observedAt: 100,
                provider: 'codex',
            },
        ];

        for (const invalid of invalidRows) {
            await expect(outbox.enqueueExactTurnEnd(
                invalid as unknown as ExactDaemonSessionTurnEndMutationV1,
            )).rejects.toThrow(/exact end/);
        }
        await outbox.close();
    });

    it('does not let a newer usage-only handle take exact-turn socket delivery authority', async () => {
        const exactSocket = vi.fn(() => ({ connected: false, emit: () => undefined }));
        const usageSocket = vi.fn(() => null);
        const exact = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: exactSocket,
            requestReconnect: () => undefined,
        });
        const usage = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: usageSocket,
            requestReconnect: () => undefined,
            deliverUsageLimitRecovery: async () => true,
        });

        await exact.enqueueExactTurnEnd({
            v: 1,
            sessionId: 's1',
            mutationId: 'end-turn-1',
            action: 'end_session',
            turnId: 'turn-1',
            observedAt: 100,
        });
        await exact.flush('flush');

        expect(exactSocket).toHaveBeenCalled();
        expect(usageSocket).not.toHaveBeenCalled();
        await usage.close();
        await exact.close();
    });

    it('does not let a newer exact-only handle shadow usage delivery authority', async () => {
        const deliverUsageLimitRecovery = vi.fn(async () => true);
        const usage = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverUsageLimitRecovery,
        });
        const exact = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({ connected: false, emit: () => undefined }),
            requestReconnect: () => undefined,
        });
        const usageMutation = createRegisteredSessionStateFieldMutation({
            sessionId: 's1',
            fieldId: 'runtime.usageLimitRecovery',
            source: 'daemon',
            observedAt: 100,
            op: { kind: 'clear' },
        }) as DaemonUsageLimitRecoveryFieldMutation;

        await usage.enqueueUsageLimitRecovery(usageMutation);
        await exact.flush('flush');

        expect(deliverUsageLimitRecovery).toHaveBeenCalledOnce();
        expect(deliverUsageLimitRecovery).toHaveBeenCalledWith(usageMutation);
        await exact.close();
        await usage.close();
    });

    it('retains capability-blocked usage while delivering later exact terminal evidence, then delivers usage exactly once', async () => {
        const deliveredExactMutationIds: string[] = [];
        const usageMutation = createRegisteredSessionStateFieldMutation({
            sessionId: 's1',
            fieldId: 'runtime.usageLimitRecovery',
            source: 'daemon',
            observedAt: 100,
            op: { kind: 'clear' },
        }) as DaemonUsageLimitRecoveryFieldMutation;
        const exactMutation: ExactDaemonSessionTurnEndMutationV1 = {
            v: 1,
            sessionId: 's1',
            mutationId: 'end-turn-after-usage',
            action: 'end_session',
            turnId: 'turn-after-usage',
            observedAt: 101,
        };
        const persistenceContext = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
            parseQueuedMutation: parseDaemonSessionClientDurableMutation,
        });
        await saveSessionClientDurableMutationOutbox('s1', [
            {
                kind: 'registered_session_state_field',
                mutationId: usageMutation.mutationId,
                payload: usageMutation,
                createdAt: usageMutation.observedAt,
                attempts: 0,
                nextAttemptAt: 0,
            },
            {
                kind: 'session_turn_mutation',
                mutationId: exactMutation.mutationId,
                payload: exactMutation,
                createdAt: exactMutation.observedAt,
                attempts: 0,
                nextAttemptAt: 0,
            },
        ], persistenceContext);
        const exact = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({
                connected: true,
                emit: () => undefined,
                emitWithAck: async (_event, mutationValue) => {
                    const deliveredMutation = mutationValue as ExactDaemonSessionTurnEndMutationV1;
                    deliveredExactMutationIds.push(deliveredMutation.mutationId);
                    return {
                        receipt: {
                            ...deliveredMutation,
                            decision: 'applied',
                            appliedAt: deliveredMutation.observedAt + 1,
                        },
                    };
                },
            }),
            requestReconnect: () => undefined,
        });

        await exact.awaitReady();
        await exact.flush('flush');

        const paths = persistenceContext.paths;
        const retained = JSON.parse(await readFile(paths.queuePath, 'utf8')) as {
            mutations: Array<{ mutationId?: string; attempts?: number }>;
        };
        expect(retained.mutations).toEqual([
            expect.objectContaining({ mutationId: usageMutation.mutationId, attempts: 0 }),
        ]);
        expect(deliveredExactMutationIds).toEqual([exactMutation.mutationId]);

        const deliverUsageLimitRecovery = vi.fn(async () => true);
        const usage = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverUsageLimitRecovery,
        });
        await usage.flush('connect');
        await usage.flush('connect');

        expect(deliverUsageLimitRecovery).toHaveBeenCalledOnce();
        expect(deliverUsageLimitRecovery).toHaveBeenCalledWith(usageMutation);
        await expect(readFile(paths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        await usage.close();
        await exact.close();
    });

    it('retains durable-required daemon usage past retry exhaustion until a capable handle binds', async () => {
        const previousMaxAttempts = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
        const previousBaseRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
        const previousMaxRetryMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS;
        const previousJitterMs = process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = '1';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = '0';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS = '0';
        process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = '0';
        try {
            const deliveredExactMutationIds: string[] = [];
            const usageMutation = createRegisteredSessionStateFieldMutation({
                sessionId: 's1',
                fieldId: 'runtime.usageLimitRecovery',
                source: 'daemon',
                observedAt: 100,
                op: { kind: 'clear' },
            }) as DaemonUsageLimitRecoveryFieldMutation;
            const exactMutation: ExactDaemonSessionTurnEndMutationV1 = {
                v: 1,
                sessionId: 's1',
                mutationId: 'end-turn-after-real-failure',
                action: 'end_session',
                turnId: 'turn-after-real-failure',
                observedAt: 101,
            };
            const persistenceContext = createSessionClientDurableMutationPersistenceContext({
                activeServerDir: configurationMock.activeServerDir,
                custody: 'daemon',
                sessionId: 's1',
                parseQueuedMutation: parseDaemonSessionClientDurableMutation,
            });
            await saveSessionClientDurableMutationOutbox('s1', [
                {
                    kind: 'registered_session_state_field',
                    mutationId: usageMutation.mutationId,
                    payload: usageMutation,
                    createdAt: usageMutation.observedAt,
                    attempts: 0,
                    nextAttemptAt: 0,
                },
                {
                    kind: 'session_turn_mutation',
                    mutationId: exactMutation.mutationId,
                    payload: exactMutation,
                    createdAt: exactMutation.observedAt,
                    attempts: 0,
                    nextAttemptAt: 0,
                },
            ], persistenceContext);
            const failingUsage = createDaemonSessionClientDurableMutationOutbox({
                token: 'token',
                sessionId: 's1',
                getSocket: () => ({
                    connected: true,
                    emit: () => undefined,
                    emitWithAck: async (_event, mutationValue) => {
                        const deliveredMutation = mutationValue as ExactDaemonSessionTurnEndMutationV1;
                        deliveredExactMutationIds.push(deliveredMutation.mutationId);
                        return {
                            receipt: {
                                ...deliveredMutation,
                                decision: 'applied',
                                appliedAt: deliveredMutation.observedAt + 1,
                            },
                        };
                    },
                }),
                requestReconnect: () => undefined,
                deliverUsageLimitRecovery: async () => false,
                enableExactTurnDelivery: true,
            });

            await failingUsage.awaitReady();
            await failingUsage.flush('flush');

            const paths = resolveSessionClientDurableMutationJournalPaths({
                activeServerDir: configurationMock.activeServerDir,
                custody: 'daemon',
                sessionId: 's1',
            });
            const retained = JSON.parse(await readFile(paths.queuePath, 'utf8')) as {
                mutations: Array<{ mutationId?: string; attempts?: number }>;
            };
            expect(retained.mutations).toEqual([
                expect.objectContaining({ mutationId: usageMutation.mutationId }),
                expect.objectContaining({ mutationId: exactMutation.mutationId, attempts: 0 }),
            ]);
            expect(retained.mutations[0]?.attempts).toBeGreaterThanOrEqual(1);
            expect(deliveredExactMutationIds).toEqual([]);

            const deliverUsageLimitRecovery = vi.fn(async () => true);
            const usage = createDaemonSessionClientDurableMutationOutbox({
                token: 'token',
                sessionId: 's1',
                getSocket: () => null,
                requestReconnect: () => undefined,
                deliverUsageLimitRecovery,
            });
            await usage.flush('flush');

            expect(deliverUsageLimitRecovery).toHaveBeenCalledOnce();
            expect(deliveredExactMutationIds).toEqual([exactMutation.mutationId]);
            await expect(readFile(paths.queuePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
            await usage.close();
            await failingUsage.close();
        } finally {
            if (previousMaxAttempts === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_ATTEMPTS = previousMaxAttempts;
            if (previousBaseRetryMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_BASE_RETRY_MS = previousBaseRetryMs;
            if (previousMaxRetryMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_MAX_RETRY_MS = previousMaxRetryMs;
            if (previousJitterMs === undefined) delete process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS;
            else process.env.HAPPIER_SESSION_MUTATION_OUTBOX_JITTER_MS = previousJitterMs;
        }
    });

    it('does not deliver persisted daemon work before coordinated bindings explicitly flush', async () => {
        const usageMutation = createRegisteredSessionStateFieldMutation({
            sessionId: 's1',
            fieldId: 'runtime.usageLimitRecovery',
            source: 'daemon',
            observedAt: 100,
            op: { kind: 'clear' },
        });
        const persistenceContext = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
            parseQueuedMutation: parseDaemonSessionClientDurableMutation,
        });
        await saveSessionClientDurableMutationOutbox('s1', [{
            kind: 'registered_session_state_field',
            mutationId: usageMutation.mutationId,
            payload: usageMutation,
            createdAt: 100,
            attempts: 0,
            nextAttemptAt: 0,
        }], persistenceContext);
        const deliverUsageLimitRecovery = vi.fn(async () => true);
        const exact = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({ connected: false, emit: () => undefined }),
            requestReconnect: () => undefined,
        });
        await exact.awaitReady();
        const usage = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverUsageLimitRecovery,
        });
        await usage.awaitReady();

        expect(deliverUsageLimitRecovery).not.toHaveBeenCalled();
        await exact.flush('startup');
        expect(deliverUsageLimitRecovery).toHaveBeenCalledOnce();

        await usage.close();
        await exact.close();
    });

    it('does not eagerly deliver a persisted exact end before the coordinated startup flush', async () => {
        const persistedExact: ExactDaemonSessionTurnEndMutationV1 = {
            v: 1,
            sessionId: 's1',
            mutationId: 'persisted-exact',
            action: 'end_session',
            turnId: 'turn-persisted',
            observedAt: 400,
        };
        const persistenceContext = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
            parseQueuedMutation: parseDaemonSessionClientDurableMutation,
        });
        await saveSessionClientDurableMutationOutbox('s1', [{
            kind: 'session_turn_mutation',
            mutationId: persistedExact.mutationId,
            payload: persistedExact,
            createdAt: persistedExact.observedAt,
            attempts: 0,
            nextAttemptAt: 0,
        }], persistenceContext);
        const delivered: string[] = [];
        const exact = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({
                connected: true,
                emit: () => undefined,
                emitWithAck: async (_event, mutationValue) => {
                    const mutation = mutationValue as ExactDaemonSessionTurnEndMutationV1;
                    delivered.push(mutation.mutationId);
                    return {
                        receipt: {
                            ...mutation,
                            decision: 'applied',
                            appliedAt: mutation.observedAt + 1,
                        },
                    };
                },
            }),
            requestReconnect: () => undefined,
        });

        await exact.awaitReady();
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        expect(delivered).toEqual([]);

        await exact.flush('startup');
        expect(delivered).toEqual(['persisted-exact']);
        await exact.close();
    });

    it('retains a failed admitted startup flush without retrying while quiescing', async () => {
        const persistedExact: ExactDaemonSessionTurnEndMutationV1 = {
            v: 1,
            sessionId: 's1',
            mutationId: 'persisted-quiesced-retry',
            action: 'end_session',
            turnId: 'turn-quiesced-retry',
            observedAt: 500,
        };
        const persistenceContext = createSessionClientDurableMutationPersistenceContext({
            activeServerDir: configurationMock.activeServerDir,
            custody: 'daemon',
            sessionId: 's1',
            parseQueuedMutation: parseDaemonSessionClientDurableMutation,
        });
        await saveSessionClientDurableMutationOutbox('s1', [{
            kind: 'session_turn_mutation',
            mutationId: persistedExact.mutationId,
            payload: persistedExact,
            createdAt: persistedExact.observedAt,
            attempts: 0,
            nextAttemptAt: 0,
        }], persistenceContext);
        let quiescing = false;
        const delivered: string[] = [];
        const usage = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => null,
            requestReconnect: () => undefined,
            deliverUsageLimitRecovery: async () => true,
        });
        const exact = createDaemonSessionClientDurableMutationOutbox({
            token: 'token',
            sessionId: 's1',
            getSocket: () => ({
                connected: true,
                emit: () => undefined,
                emitWithAck: async (_event, mutationValue) => {
                    const mutation = mutationValue as ExactDaemonSessionTurnEndMutationV1;
                    delivered.push(mutation.mutationId);
                    if (delivered.length === 1) {
                        quiescing = true;
                        throw new Error('replacement publication gap');
                    }
                    return {
                        receipt: {
                            ...mutation,
                            decision: 'applied',
                            appliedAt: mutation.observedAt + 1,
                        },
                    };
                },
            }),
            requestReconnect: () => undefined,
            isShuttingDown: () => quiescing,
        });
        const realSetImmediate = setImmediate;

        vi.useFakeTimers();
        try {
            await exact.awaitReady();
            await exact.flush('startup');
            expect(delivered).toEqual(['persisted-quiesced-retry']);
            expect(vi.getTimerCount()).toBeGreaterThan(0);

            await vi.runAllTimersAsync();
            for (let index = 0; index < 20 && delivered.length === 1; index += 1) {
                await new Promise<void>((resolve) => realSetImmediate(resolve));
            }

            expect(delivered).toEqual(['persisted-quiesced-retry']);
            await expect(readFile(persistenceContext.paths.queuePath, 'utf8'))
                .resolves.toContain(persistedExact.mutationId);

            quiescing = false;
            await exact.flush('startup');
            expect(delivered).toEqual([
                'persisted-quiesced-retry',
                'persisted-quiesced-retry',
            ]);
            await expect(readFile(persistenceContext.paths.queuePath, 'utf8'))
                .rejects.toMatchObject({ code: 'ENOENT' });
            await exact.close();
            await usage.close();
        } finally {
            vi.useRealTimers();
        }
    });
});
