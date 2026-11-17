import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'socket.io';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MACHINE_PLAIN_DATA_KEY_MARKER, encodePlainMachineStoredContent } from '@happier-dev/protocol';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observeSqliteRequests } from '@/testkit/observeSqliteRequests';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { applySessionTurnMutation } from '@/app/session/sessionWriteService';
import { publishSessionTurnMutationUpdate } from '@/app/session/turns/publishSessionTurnMutationUpdate';
import { readSessionDetail } from '@/app/api/routes/session/registerSessionListingRoutes';
import { evaluateAccountStoredContentCompatibility } from '@/app/clientCompatibility/accountStoredContentCompatibility';
import { parseAccountStoredContentCompatibilityHttpHeadersV1 } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { currentAccountStoredContentCompatibilityHeaders } from '@/app/api/testkit/accountStoredContentCompatibility';
import { createFakeSocket } from '@/app/api/testkit/socketHarness';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { enqueuePendingMessage, materializeNextPendingMessage, resolveAcceptedPendingDelivery, settlePendingInputAdmission } from './pendingMessageService';

const SERVER_IDENTITY_ID = 'srv_01234567890123456789012345678901';
const authentication = createPresentUserSessionAccessAuthentication();

/** Prisma operations per hot-turn event on the shipped SQLite light server (real IO, observed at Prisma's request adapter). */
describe('pending pipeline operations per turn event (real SQLite)', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-pending-pipeline-ops-', initAuth: false,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_SERVER_IDENTITY_ID: SERVER_IDENTITY_ID } });
    }, 120_000);
    afterAll(async () => { if (harness) await harness.close(); });
    afterEach(() => { harness.resetEnv(); });

    /** The turn harness shape: an owner's Session placed on the owner's own installed Machine. */
    async function placedSession() {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            metadata: encodePlainMachineStoredContent({ host: 'host', platform: 'linux', happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
            dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1, 2] } }, operationProtocolCapabilitiesRevision: 1 } });
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', active: true } });
        await db.accessKey.create({ data: { accountId: owner.id, sessionId: session.id, machineId: machine.id, data: 'private-key-ciphertext' } });
        await db.session.update({ where: { id: session.id }, data: { runtimeMachineTarget: {
            homeId: SERVER_IDENTITY_ID, accountId: owner.id, sessionId: session.id, machineId: machine.id, installationId: machine.installationId,
        } } });
        return { owner, machine, session };
    }

    /** Operations caused by `run`, attributed by async context (as the live per-context counter does), so a prior event's after-commit work is excluded. */
    async function operations<T>(run: () => Promise<T>): Promise<{ result: T; operations: string[] }> {
        const observed: string[] = [];
        const context = new AsyncLocalStorage<true>();
        const stop = observeSqliteRequests({ before: request => {
            if (context.getStore()) observed.push(`${request.model ?? 'raw'}.${request.action}`);
        } });
        try {
            return { result: await context.run(true, run), operations: observed };
        } finally { stop(); }
    }

    function send(f: Awaited<ReturnType<typeof placedSession>>) {
        return enqueuePendingMessage({ actorUserId: f.owner.id, authentication, sessionId: f.session.id, localId: randomUUID(),
            requestedAction: { v: 1, kind: 'send_now' },
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'prompt' } } } });
    }

    const count = (operations: readonly string[], predicate: (operation: string) => boolean) => operations.filter(predicate).length;
    const placementRead = (operation: string) => /^(Machine|ManagedMachine|AccessKey)\./.test(operation);
    const sessionRead = (operation: string) => operation.startsWith('Session.find');

    it('sends one message deciding the Machine target once', async () => {
        const f = await placedSession();
        await send(f);
        const measured = await operations(() => send(f));
        expect(measured.result).toMatchObject({ ok: true, activationTarget: { machinePublication: { target: { machineId: f.machine.id } } } });
        console.info('PENDING_SEND_OPS', measured.operations.length, JSON.stringify(measured.operations));
        // The lock audience reads stored placement and its controllers once (single writer: nothing to re-check);
        // Machine admission runs once under the lock and arming reuses it. RED (HEAD 16752d681eb): 26 placement reads.
        expect(count(measured.operations, placementRead)).toBe(7);
        // One read of each retained row for the localId serves reply, suppression and idempotency checks. RED: 4 + 2.
        expect(count(measured.operations, operation => operation === 'SessionMessage.findUnique')).toBe(1);
        // Pending counters are written from the locked read in one update (no CAS re-read). RED: 13.
        expect(count(measured.operations, sessionRead)).toBe(8);
    });

    it('applies one turn status update from one Session read', async () => {
        const f = await placedSession();
        const turnId = `turn-${randomUUID()}`;
        const begun = await operations(() => applySessionTurnMutation({ actorUserId: f.owner.id, authentication, mutation: {
            v: 1, sessionId: f.session.id, mutationId: randomUUID(), action: 'begin', turnId, observedAt: Date.now() - 1_000 } }));
        expect(begun.result).toMatchObject({ ok: true, didApply: true });
        // The Turn's Team credential witness reads every delivery route's binding in one read. RED (HEAD 660e99616d9): 3.
        expect(count(begun.operations, operation => operation.startsWith('SessionTeamCredentialBinding.'))).toBe(1);
        const measured = await operations(() => applySessionTurnMutation({ actorUserId: f.owner.id, authentication, mutation: {
            v: 1, sessionId: f.session.id, mutationId: randomUUID(), action: 'complete', turnId, observedAt: Date.now() } }));
        expect(measured.result).toMatchObject({ ok: true, didApply: true, latestTurnStatus: 'completed' });
        if (!measured.result.ok) throw new Error('Expected the turn status update to apply');
        const appliedResult = measured.result;
        const published = await operations(() => publishSessionTurnMutationUpdate({ sessionId: f.session.id, actorUserId: f.owner.id,
            result: appliedResult }));
        console.info('TURN_STATUS_OPS', measured.operations.length, JSON.stringify(measured.operations), JSON.stringify(published.operations));
        // The after-commit push uses the committed update's own recipient projection. RED (HEAD 660e99616d9): 1 Session read.
        expect(count(published.operations, sessionRead)).toBe(0);
        // Context, storage authority and turn facts share one locked read; the update returns the publication
        // fields; notify-once acceptance stops at one witness read when nobody holds one. RED: 7 Session reads, 4 Account ops.
        // The change row links the Session the update just wrote without an existence read. RED (HEAD 660e99616d9): 2.
        expect(count(measured.operations, sessionRead)).toBe(1);
        expect(count(measured.operations, operation => operation.startsWith('Account.'))).toBe(2);
    });

    it('materializes, settles and accepts one Pending input reading its retained row once per decision', async () => {
        const f = await placedSession();
        const content = { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'prompt' } } } as const;
        const localId = randomUUID();
        expect(await enqueuePendingMessage({ actorUserId: f.owner.id, authentication, sessionId: f.session.id, localId,
            requestedAction: { v: 1, kind: 'send_now' }, content })).toMatchObject({ ok: true });
        const binding = { accountId: f.owner.id, sessionId: f.session.id, machineId: f.machine.id };
        const registered = await createSessionPublisherPresence().registerPublisher({ socket: createFakeSocket() as unknown as Socket,
            binding, completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
        if (registered.status !== 'registered') throw new Error('Expected the placed publisher to be admitted');
        const publisherAuthority = { ...binding, committedFence: registered.committedFence };
        const materialized = await operations(() => materializeNextPendingMessage({ actorUserId: f.owner.id, sessionId: f.session.id,
            deliveryState: 'provider', deliveryTiming: 'after_foreground_ready', foregroundState: 'ready', publisherAuthority }));
        expect(materialized.result).toMatchObject({ ok: true, didMaterialize: true });
        const settled = await operations(() => settlePendingInputAdmission({ actorUserId: f.owner.id, sessionId: f.session.id,
            localId, publisherAuthority, decision: { kind: 'admit', finalContent: content } }));
        expect(settled.result).toMatchObject({ ok: true, result: { status: 'accepted', localId } });
        const accepted = await operations(() => resolveAcceptedPendingDelivery({ actorUserId: f.owner.id, sessionId: f.session.id,
            localId, publisherAuthority }));
        expect(accepted.result).toMatchObject({ ok: true, didResolve: true });
        console.info('MATERIALIZE_OPS', materialized.operations.length, JSON.stringify(materialized.operations));
        console.info('SETTLE_OPS', settled.operations.length, JSON.stringify(settled.operations));
        console.info('ACCEPTED_OPS', accepted.operations.length, JSON.stringify(accepted.operations));
        const pendingRowRead = (operation: string) => operation === 'SessionPendingMessage.findUnique';
        // One read of the fenced Session row serves admission, rejoin and the drain decision (the other three are the
        // publisher fence, the activation reconcile and the post-update publication read). RED (HEAD e4edd8f0a7d): 7.
        expect(count(materialized.operations, operation => /^Session\.findUnique(OrThrow)?$/.test(operation))).toBe(5);
        // The retained row: one read under the lock that also serves domain validation and the reply check, and
        // one custody carry onto the Message. SQLite's fence locks no rows, so it runs no lock-audience census
        // and reads no row before it. RED: 6, then 3 (HEAD 3ba6310f489).
        expect(count(settled.operations, pendingRowRead)).toBe(2);
        // The publisher-authority read carries the owner and encryption mode the settlement decides from (the
        // others: the mutation's own Session reads and two change-row links). RED (HEAD 3ba6310f489): 6.
        expect(count(settled.operations, operation => /^Session\.findUnique(OrThrow)?$/.test(operation))).toBe(5);
        // The resolved row and one custody carry. RED: 3.
        expect(count(accepted.operations, pendingRowRead)).toBe(2);
    });

    it('reads the Session runner snapshot without viewer or launch facts', async () => {
        const f = await placedSession();
        const storedContentCompatibility = evaluateAccountStoredContentCompatibility(
            parseAccountStoredContentCompatibilityHttpHeadersV1(currentAccountStoredContentCompatibilityHeaders));
        const full = await operations(() => readSessionDetail({ userId: f.owner.id, sessionId: f.session.id, authentication, storedContentCompatibility }));
        const snapshot = await operations(() => readSessionDetail({ userId: f.owner.id, sessionId: f.session.id, authentication,
            storedContentCompatibility, runtimeSnapshot: true }));
        console.info('DRAIN_READ_OPS', full.operations.length, snapshot.operations.length, JSON.stringify(snapshot.operations));
        if (full.result.status !== 200 || snapshot.result.status !== 200) throw new Error('Expected both detail reads to succeed');
        const { viewer: _viewer, lastViewedSessionSeq: _seq, unreadSince: _unread, hasOtherNamedCollaborator: _named,
            acceptedTeamCredentialBinding: _binding, receivedRuleCount: _rules, ...shared } = full.result.body.session;
        // The runner's consumed state is identical; personal and launch facts are absent rather than defaulted.
        expect(snapshot.result.body.session).toEqual(shared);
        expect(snapshot.result.body.session).not.toHaveProperty('viewer');
        // RED (HEAD): the runner read loaded the viewer's rule KV, Discussions, failure sequence and named collaborators,
        // and the owner's launch bindings and activation (15 ops; GREEN 7).
        expect(snapshot.operations.filter(operation => /^(UserKVStore|Discussion|SessionTeamCredentialBinding|SessionGrant)\./.test(operation)))
            .toEqual([]);
        expect(snapshot.operations).toHaveLength(7);
    });
});
