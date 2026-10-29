import { randomUUID } from 'node:crypto';
import { decodeBase64 } from 'privacy-kit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { deriveSessionFollowOriginalOccurrenceKeyV1, SessionFollowInputV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1, SessionFollowAdmittedInputAcknowledgeRequestV1Schema,
    SessionFollowAcknowledgeResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';

import { createAuthenticatedFakeSocket, getSocketHandler } from '@/app/api/testkit/socketHarness';
import { sessionUpdateHandler } from '@/app/api/socket/sessionUpdateHandler';
import { createSessionPublisherPresence } from '@/app/presence/sessionPublisherPresence';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { db, initDbPostgres } from '@/storage/db';
import { getDbProviderFromEnv } from '@/storage/prisma';
import { getAccountFollowRule, setAccountFollowRule } from './accountFollowRuleService';

/** Only the socket transport and persisted input fixture are supplied; ACK and progress owners are real. */
async function createAdmittedRulePublisher() {
    const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const authentication = createPresentUserSessionAccessAuthentication({ env: {} });
    const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id,
        installationId: randomUUID(), metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
        operationProtocolCapabilities: { sessionFollow: { contextV1: true } } } });
    const source = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
    const destination = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain' } });
    await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: destination.id,
        data: MACHINE_PLAIN_DATA_KEY_MARKER } });
    const presence = createSessionPublisherPresence();
    const socket = createAuthenticatedFakeSocket({ id: randomUUID() });
    const binding = { accountId: owner.id, machineId: machine.id, sessionId: destination.id };
    const registered = await presence.registerPublisher({ socket, binding, completeActivitySnapshot: { state: 'idle', activeCount: 0 } });
    expect(registered).toMatchObject({ status: 'registered' });
    if (registered.status !== 'registered') throw new Error('Expected destination publisher');
    sessionUpdateHandler(owner.id, socket as never, { connectionType: 'session-scoped', socket,
        userId: owner.id, sessionId: destination.id } as never, { presence, binding });
    const scope = { accountId: owner.id, authentication, ruleId: randomUUID() };
    const created = await setAccountFollowRule({ ...scope, mutation: { expectedVersion: -1,
        receiver: { kind: 'session', sessionId: destination.id }, content: { t: 'plain', v: {
            v: 1, enabled: true, filter: normalizeSessionListFilterV1(), policy: { preset: 'important' },
        } } } });
    expect(created).toMatchObject({ ok: true });
    if (!created.ok) throw new Error(created.error);
    const prepare = async (seq: number) => {
        const sourceMessage = { localId: randomUUID(), seq };
        await db.sessionMessage.create({ data: { sessionId: source.id, ...sourceMessage, messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: [] } } } });
        await db.session.update({ where: { id: source.id }, data: { seq } });
        const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn', event: { kind: 'update_posted' },
            original: { sourceSessionId: source.id, sourceMessage } });
        const localInputId = randomUUID();
        const receipt = SessionInputAdmissionReceiptV1Schema.parse({ v: 1, issuer: 'authenticatedMachine',
            admittedTarget: { homeId: 'follow-contract-home', accountId: owner.id, sessionId: destination.id,
                machineId: machine.id, installationId: machine.installationId! }, followDeliveryV1: delivery,
            followSources: [{ evaluation: 'receiver', destinationSessionId: destination.id, sourceSessionId: source.id,
                sourceMessage, selectedDelivery: delivery.delivery,
                rule: { ruleId: scope.ruleId, ruleVersion: created.value.rule.version } }] });
        await db.sessionMessage.create({ data: { sessionId: destination.id, localId: localInputId, seq,
            messageRole: 'user', acceptedTurnId: `accepted-${seq}`, inputAdmissionReceipt: receipt,
            acceptedFollowOriginalKey: deriveSessionFollowOriginalOccurrenceKeyV1(delivery.original),
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Follow original' } } } } });
        const expected = { transcriptSeq: seq - 1, readyEventSeq: 0, agentStateVersion: 0, turn: null };
        const observed = { ...expected, transcriptSeq: seq };
        const request = SessionFollowAdmittedInputAcknowledgeRequestV1Schema.parse({ v: 1, destinationSessionId: destination.id,
            sourceSessionId: source.id, localInputId, expectedPublisherGeneration: registered.publisherGeneration.toString(),
            expected, observed, consumed: observed, acceptance: { kind: 'admitted_input', localInputId, userMessageSeq: seq } });
        return async () => {
            let response: unknown;
            await getSocketHandler(socket, SESSION_FOLLOW_ACKNOWLEDGE_EVENT_V1)(request, (value: unknown) => { response = value; });
            return SessionFollowAcknowledgeResponseV1Schema.parse(response);
        };
    };
    const assertProgress = async (seq: number) => {
        expect(await getAccountFollowRule(scope)).toMatchObject({ ok: true, value: { rule: {
            sources: [{ sourceSessionId: source.id, delivered: { transcriptSeq: seq } }],
        } } });
    };
    return { owner, destination, prepare, assertProgress,
        close: () => presence.forgetDisconnectedPublisher({ socket }) };
}

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Admitted Follow rule ACK resource admission on PostgreSQL', () => {
    const environment = new Map<string, string | undefined>();
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error('Missing disposable PostgreSQL DATABASE_URL');
        for (const key of ['HAPPIER_FEATURE_SESSIONS__ENABLED', 'HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED']) {
            environment.set(key, process.env[key]); process.env[key] = '1';
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => {
        await db.$disconnect();
        for (const [key, value] of environment) {
            if (value === undefined) delete process.env[key]; else process.env[key] = value;
        }
    });

    it.each([false, true])('locks the destination before Account publication and rechecks a replaced publisher (%s)', async replacePublisher => {
        const fixture = await createAdmittedRulePublisher();
        try {
            // Prove that this public ACK actually reaches the rule KV writer
            // and destination publication before using it as a race witness.
            expect(await (await fixture.prepare(1))()).toMatchObject({ ok: true });
            await fixture.assertProgress(1);
            expect(await db.accountChange.findFirst({ where: { accountId: fixture.owner.id, kind: 'session',
                entityId: fixture.destination.id } })).toMatchObject({ sessionId: fixture.destination.id });
            const acknowledge = await fixture.prepare(2);
            // Existing coalesced rows need not recheck the Session FK. Force
            // the fresh insert that exposes the physical-delete lock edge.
            await db.accountChange.deleteMany({ where: { accountId: fixture.owner.id, kind: 'session', entityId: fixture.destination.id } });
            let release!: () => void;
            let acquired!: (pid: number) => void;
            const gate = new Promise<void>(resolve => { release = resolve; });
            const ready = new Promise<number>(resolve => { acquired = resolve; });
            // Raw transport intentionally does not retry NOWAIT refusal;
            // production inTx would hide the deciding inverted lock edge.
            const holder = db.$transaction(async tx => {
                await tx.$queryRaw`SELECT "id" FROM "Session" WHERE "id" = ${fixture.destination.id} FOR UPDATE`;
                const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
                acquired(backend!.pid);
                await gate;
                await tx.$queryRaw`SELECT "id" FROM "Account" WHERE "id" = ${fixture.owner.id} FOR NO KEY UPDATE NOWAIT`;
                if (replacePublisher) await tx.session.update({ where: { id: fixture.destination.id }, data: { publisherGeneration: { increment: 1 } } });
            }, { timeout: 30_000 }).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
            let pending: ReturnType<typeof acknowledge> | undefined;
            try {
                const pid = await ready;
                pending = acknowledge();
                await vi.waitFor(async () => {
                    const [waiting] = await db.$queryRaw<Array<{ blocked: boolean }>>`
                        SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE ${pid}::int = ANY(pg_blocking_pids(pid))) AS blocked`;
                    expect(waiting?.blocked).toBe(true);
                });
                release();
                expect(await holder).toEqual({ ok: true });
                expect(await pending).toMatchObject(replacePublisher
                    ? { ok: false, error: 'stale_publisher_generation' } : { ok: true });
                await fixture.assertProgress(replacePublisher ? 1 : 2);
            } finally {
                release();
                await holder;
                await pending;
            }
        } finally {
            await fixture.close();
            // The disposable database harness owns related-row teardown.
        }
    });
});
