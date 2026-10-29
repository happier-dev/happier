import { randomUUID } from 'node:crypto';
import { buildSessionFollowReceiverChangeEntityIdV1 } from '@happier-dev/protocol/sessions/follow/changes';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { encodeBase64, MACHINE_PLAIN_DATA_KEY_MARKER, TranscriptRawAgentEventV1Schema } from '@happier-dev/protocol';
import { deriveSessionFollowWakeEventLocalIdV1, SESSION_FOLLOW_WAKE_EVENT_MESSAGE, SessionFollowObservePendingResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import type { FollowPolicyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';

import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { transitionSessionArchiveStateInTx } from '@/app/session/archive/transitionSessionArchiveStateInTx';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { eventRouter } from '@/app/events/eventRouter';
import { markSessionProjectionRecipientsChanged } from '@/app/session/changeTracking/markSessionProjectionRecipientsChanged';
import { changeDeliveryMute } from './sessionDeliveryMuteService';
import { setSessionManager } from './sessionManagerService';
import { sourceKeyForSessionFollowSourceV1 } from './sessionFollowSourceIdentity';
import { readAdmittedSessionFollowInputInTx, readSessionFollowOriginalOccurrenceFrontiersInTx, sessionFollowInputFrontiers, settleSessionFollowInputReasonsInTx } from './sessionFollowRuleProgress';
import { setAccountFollowRule } from './accountFollowRuleService';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { buildSessionInputAdmissionReceipt } from '@/app/session/messages/sessionInputAdmission';
import { SessionInputAdmissionReceiptV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionFollowInputV1Schema, deriveSessionFollowInputLocalIdV1, deriveSessionFollowOriginalOccurrenceKeyV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { decodeBase64 } from 'privacy-kit';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { sessionPendingRoutes } from '@/app/api/routes/session/pendingRoutes';
import { getOrCreateServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';

import {
    admitSessionFollowRelationsForInputInTx,
    acknowledgeSessionFollowFrontierInTx as acknowledgeSessionFollowFrontierAuthenticatedInTx,
    authorizeSessionFollowSourceKeyPreparation as authorizeSessionFollowSourceKeyPreparationAuthenticated,
    authorizeSessionFollowSourceKeyPreparer,
    listSessionFollowSources as listSessionFollowSourcesAuthenticated,
    observePendingSessionFollowForDestinationInTx as observeSessionFollowForDestinationInTx,
    projectSessionFollowSourceForRunnerInTx,
    removeUnsafeSessionFollowEdgesForAccessChangeInTx,
    removeSessionFollowSource as removeSessionFollowSourceAuthenticated,
    setSessionFollowSource as setSessionFollowSourceAuthenticated,
} from './sessionFollowEdgeService';

const authentication = createPresentUserSessionAccessAuthentication({ env: {} });

// Most assertions in this file predate authoritative membership being returned
// beside delivery deltas. Keep them focused on pending delivery; membership has
// its own discriminating lifecycle assertion below.
const observePendingSessionFollowForDestinationInTx = async (
    ...args: Parameters<typeof observeSessionFollowForDestinationInTx>
) => (await observeSessionFollowForDestinationInTx(...args)).observations.filter(row => 'sourceSessionId' in row);

// Legacy fixture cases explicitly configure Everything for ordinary routes;
// manager fixture creation uses the production Important default.
const acknowledgeSessionFollowFrontierInTx = (tx: Tx,
    input: Omit<Parameters<typeof acknowledgeSessionFollowFrontierAuthenticatedInTx>[1], 'policy'> & { policy?: FollowPolicyV1 },
) => acknowledgeSessionFollowFrontierAuthenticatedInTx(tx, {
    policy: { preset: input.relation === 'manager' ? 'important' : 'everything' }, ...input,
});

const listSessionFollowSources = (
    input: Omit<Parameters<typeof listSessionFollowSourcesAuthenticated>[0], 'authentication'>,
) => listSessionFollowSourcesAuthenticated({ ...input, authentication });

const setSessionFollowSource = (
    input: Omit<Parameters<typeof setSessionFollowSourceAuthenticated>[0], 'authentication' | 'policy'> & { policy?: FollowPolicyV1 },
) => setSessionFollowSourceAuthenticated({ policy: { preset: 'everything' }, ...input, authentication });

const removeSessionFollowSource = (
    input: Omit<Parameters<typeof removeSessionFollowSourceAuthenticated>[0], 'authentication'>,
) => removeSessionFollowSourceAuthenticated({ ...input, authentication });

const authorizeSessionFollowSourceKeyPreparation = (
    input: Omit<Parameters<typeof authorizeSessionFollowSourceKeyPreparationAuthenticated>[0], 'authentication'>,
) => authorizeSessionFollowSourceKeyPreparationAuthenticated({ ...input, authentication });

async function createAccount() {
    return await db.account.create({ data: { publicKey: `pk-${randomUUID()}`, encryptionMode: 'plain' } });
}

async function createSession(accountId: string, overrides: Record<string, unknown> = {}) {
    return await db.session.create({
        data: {
            accountId,
            tag: `s-${randomUUID()}`,
            metadata: '{}',
            encryptionMode: 'plain',
            ...overrides,
        },
    });
}

async function grantAccess(
    session: { id: string; accountId: string },
    accountId: string,
    accessLevel: 'view' | 'edit' | 'admin',
) {
    await db.sessionShare.create({
        data: {
            session: { connect: { id: session.id } },
            sharedByUser: { connect: { id: session.accountId } },
            sharedWithUser: { connect: { id: accountId } },
            accessLevel,
        },
    });
}

async function readEdge(destinationSessionId: string, sourceSessionId: string) {
    return await db.sessionFollowEdge.findUnique({
        where: { destinationSessionId_sourceSessionId_relation: { destinationSessionId, sourceSessionId, relation: 'follower' } },
    });
}

async function loadPublisherGeneration(sessionId: string): Promise<bigint> {
    const row = await db.session.findUniqueOrThrow({ where: { id: sessionId }, select: { publisherGeneration: true } });
    return row.publisherGeneration;
}

/** The verified destination-runtime principal for the service's runtime lanes. */
const runtimePrincipal = (accountId: string) => ({
    kind: 'destination_runtime',
    destinationRuntimeAccountId: accountId,
    authentication,
}) as const;

const SEEDED_SOURCE = {
    seq: 5,
    latestReadyEventSeq: 3,
    agentStateVersion: 2,
    latestTurnId: 'turn-a',
    latestTurnStatus: 'completed',
} as const;

describe('SessionFollowEdge service', () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: 'happier-session-follow-edge-',
            initEncrypt: true,
            env: { HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional', HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: 'true' },
        });
    }, 180_000);

    afterEach(async () => {
        eventRouter.clearIo();
        await db.sessionFollowEdge.deleteMany();
        await db.accessKey.deleteMany();
        await db.ephemeralRunnerActivation.deleteMany();
        await db.machine.deleteMany();
        await db.sessionShare.deleteMany();
        await db.sessionMessage.deleteMany();
        await db.session.deleteMany();
        await db.team.deleteMany();
        await db.account.deleteMany();
    });

    it('keeps Session and Discussion source identities distinct and enforces source correspondence and cascades', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        const discussion = await db.discussion.create({ data: {
            id: source.id, ownerAccountId: owner.id, encryptionMode: 'plain', dataEncryptionKey: new Uint8Array(),
            creationLocalId: randomUUID(), creationEqualityEvidenceV1: {}, titleContent: {}, messageSeq: 7, lastMessageAt: new Date(),
        } });
        const sessionResult = await setSessionFollowSource({ policy: { preset: 'everything' as const }, accountId: owner.id,
            sourceSessionId: source.id, destinationSessionId: destination.id });
        expect(sessionResult.ok).toBe(true);
        await db.$executeRaw`INSERT INTO "SessionFollowEdge"
            ("sourceKey", "sourceDiscussionId", "destinationSessionId", "relation", "policyJson", "deliveredTranscriptSeq")
            VALUES (${`discussion:${discussion.id}`}, ${discussion.id}, ${destination.id}, 'follower', '{"preset":"important"}', 7)`;
        expect(await db.$queryRaw`SELECT "sourceKey", "sourceSessionId", "sourceDiscussionId", CAST("deliveredTranscriptSeq" AS TEXT) AS "deliveredTranscriptSeq"
            FROM "SessionFollowEdge" WHERE "destinationSessionId" = ${destination.id} ORDER BY "sourceKey"`)
            .toEqual([
                { sourceKey: `discussion:${discussion.id}`, sourceSessionId: null, sourceDiscussionId: discussion.id, deliveredTranscriptSeq: '7' },
                { sourceKey: `session:${source.id}`, sourceSessionId: source.id, sourceDiscussionId: null, deliveredTranscriptSeq: '0' },
            ]);
        expect(await listSessionFollowSources({ accountId: owner.id, destinationSessionId: destination.id }))
            .toMatchObject({ ok: true, value: { sources: [{ sourceSessionId: source.id }] } });
        expect(await inTx(tx => removeUnsafeSessionFollowEdgesForAccessChangeInTx(tx, { sessionId: destination.id }))).toBe(0);
        expect(await removeSessionFollowSource({ accountId: owner.id, sourceSessionId: source.id, destinationSessionId: destination.id }))
            .toMatchObject({ ok: true, value: { changed: true } });
        expect(await db.sessionFollowEdge.findUnique({ where: { destinationSessionId_sourceDiscussionId_relation: {
            destinationSessionId: destination.id, sourceDiscussionId: discussion.id, relation: 'follower',
        } }, select: { deliveredTranscriptSeq: true } })).toEqual({ deliveredTranscriptSeq: 7 });
        expect((await setSessionFollowSource({ policy: { preset: 'everything' as const }, accountId: owner.id, sourceSessionId: source.id, destinationSessionId: destination.id })).ok).toBe(true);
        await expect(db.$executeRaw`UPDATE "SessionFollowEdge" SET "sourceKey" = 'session:wrong'
            WHERE "sourceDiscussionId" = ${discussion.id}`).rejects.toThrow();
        await expect(db.$executeRaw`UPDATE "SessionFollowEdge" SET "sourceSessionId" = ${source.id}
            WHERE "sourceDiscussionId" = ${discussion.id}`).rejects.toThrow();
        await expect(db.$executeRaw`UPDATE "SessionFollowEdge" SET "relation" = 'manager', "managerSourceSessionId" = ${source.id}
            WHERE "sourceDiscussionId" = ${discussion.id}`).rejects.toThrow();
        await db.discussion.delete({ where: { id: discussion.id } });
        expect(await db.sessionFollowEdge.count({ where: { destinationSessionId: destination.id } })).toBe(1);
        await db.session.delete({ where: { id: source.id } });
        expect(await db.sessionFollowEdge.count({ where: { destinationSessionId: destination.id } })).toBe(0);
    });

    it('verifies an exact terminal Turn original and settles it without consuming the report suffix', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, { seq: 100, agentStateVersion: 9 });
        const destination = await createSession(owner.id);
        await db.sessionTurn.create({ data: { sessionId: source.id, turnId: 'terminal-original',
            status: 'failed', startedAt: 10n, updatedAt: 20n, terminalAt: 20n } });
        expect((await setSessionFollowSource({ accountId: owner.id, sourceSessionId: source.id,
            destinationSessionId: destination.id })).ok).toBe(true);
        const edge = await db.sessionFollowEdge.update({ where: { destinationSessionId_sourceSessionId_relation: {
            destinationSessionId: destination.id, sourceSessionId: source.id, relation: 'follower',
        } }, data: { deliveredTranscriptSeq: 7, deliveredAgentStateVersion: 2 } });
        const delivered = { transcriptSeq: 7, readyEventSeq: 0, agentStateVersion: 2, turn: null };
        const occurrence = { sourceSessionId: source.id, sourceTurn: { id: 'terminal-original', status: 'failed' as const } };
        const original = await inTx(tx => readSessionFollowOriginalOccurrenceFrontiersInTx(tx, { source, occurrence, delivered }));
        expect(original).toMatchObject({ baseline: delivered, observed: { ...delivered, turn: occurrence.sourceTurn } });
        expect(await inTx(tx => readSessionFollowOriginalOccurrenceFrontiersInTx(tx, { source,
            occurrence: { ...occurrence, sourceTurn: { ...occurrence.sourceTurn, status: 'completed' } }, delivered }))).toBeNull();
        const delivery = { v: 1 as const, delivery: 'next_turn' as const, original: occurrence,
            event: { kind: 'failed_or_stopped' as const } };
        const admission = { accountId: owner.id, destinationSessionId: destination.id, authentication,
            delivery, relations: [{ relation: 'follower' as const }] };
        expect(await inTx(tx => admitSessionFollowRelationsForInputInTx(tx, admission))).toHaveLength(1);
        expect(await inTx(tx => admitSessionFollowRelationsForInputInTx(tx, { ...admission,
            delivery: { ...delivery, event: { kind: 'finished' } } }))).toBeNull();
        await inTx(tx => settleSessionFollowInputReasonsInTx(tx, { progresses: [], relations: [edge], delivery,
            observed: sessionFollowInputFrontiers(delivery).observed }));
        expect(await readEdge(destination.id, source.id)).toMatchObject({ deliveredTranscriptSeq: 7,
            deliveredAgentStateVersion: 2, deliveredTurnId: occurrence.sourceTurn.id, deliveredTurnStatus: 'failed' });
    });

    it('rejects a direct Pending terminal notice backed only by a source message', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, { seq: 2 });
        const destination = await createSession(owner.id);
        const localId = randomUUID();
        await db.sessionMessage.create({ data: { sessionId: source.id, seq: 1, localId, messageRole: 'event',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'event', id: localId,
                data: TranscriptRawAgentEventV1Schema.parse({ type: 'ready', completedTurnId: 'unverified-turn' }) } } } } });
        const reportLocalId = randomUUID();
        await db.sessionMessage.create({ data: { sessionId: source.id, seq: 2, localId: reportLocalId, messageRole: 'agent',
            content: { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'An ordinary report' } } } } });
        expect((await setSessionFollowSource({ accountId: owner.id, sourceSessionId: source.id,
            destinationSessionId: destination.id })).ok).toBe(true);
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            active: true, metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: destination.id,
            data: MACHINE_PLAIN_DATA_KEY_MARKER } });
        await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: {
            homeId: await getOrCreateServerIdentityId(), accountId: owner.id, sessionId: destination.id,
            machineId: machine.id, installationId: machine.installationId!,
        } } });
        const original = { sourceSessionId: source.id, sourceMessage: { localId, seq: 1 } };
        const terminalLocalId = deriveSessionFollowInputLocalIdV1({ destinationSessionId: destination.id, original });
        await withAuthenticatedTestApp(sessionPendingRoutes, async app => {
            const controlOriginal = { sourceSessionId: source.id, sourceMessage: { localId: reportLocalId, seq: 2 } };
            const control = await app.inject({ method: 'POST', url: `/v2/sessions/${destination.id}/pending`,
                headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' },
                payload: { targetMachineId: machine.id, localId: deriveSessionFollowInputLocalIdV1({ destinationSessionId: destination.id, original: controlOriginal }),
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Ordinary report' } } },
                    requestedAction: { v: 1, kind: 'enqueue' }, followRelations: [{ relation: 'follower' }],
                    followDeliveryV1: { v: 1, delivery: 'wake', original: controlOriginal, event: { kind: 'update_posted' } } },
            });
            expect(control.statusCode, control.body).toBe(200);
            const response = await app.inject({ method: 'POST', url: `/v2/sessions/${destination.id}/pending`,
                headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' },
                payload: { targetMachineId: machine.id, localId: terminalLocalId,
                    content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Unverified terminal notice' } } },
                    requestedAction: { v: 1, kind: 'enqueue' }, followRelations: [{ relation: 'follower' }],
                    followDeliveryV1: { v: 1, delivery: 'wake', original, event: { kind: 'finished' } } },
            });
            expect(response.statusCode, response.body).toBe(400);
        });
        expect(await db.sessionPendingMessage.count({ where: { sessionId: destination.id, localId: terminalLocalId } })).toBe(0);
        expect(await db.sessionMessage.count({ where: { sessionId: destination.id } })).toBe(0);
    });

    it.each([false, true])('rejects stale wake writes and replays before reoffering the same original quietly (private Quiet: %s)', async privateQuiet => {
        const owner = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        expect(await setSessionManager({ accountId: owner.id, sessionId: source.id, managerSessionId: destination.id,
            expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
        const manager = await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: source.id } });
        const ruleId = randomUUID();
        if (privateQuiet) expect(await setAccountFollowRule({ accountId: owner.id, ruleId, authentication, mutation: {
            receiver: { kind: 'session', sessionId: destination.id }, expectedVersion: -1,
            content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1({
                homeServerIds: [await getOrCreateServerIdentityId()], startedBy: ['you', 'triggers', 'agents'] }),
                policy: { preset: 'quiet' } } },
        } })).toMatchObject({ ok: true });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: owner.id, installationId: randomUUID(),
            active: true, metadata: encodePlainMachineStoredContent({}), dataEncryptionKey: decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER),
            operationProtocolCapabilities: { sessionInputAdmission: { protocolVersions: [1] } }, operationProtocolCapabilitiesRevision: 1 } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: destination.id,
            data: MACHINE_PLAIN_DATA_KEY_MARKER } });
        await db.session.update({ where: { id: destination.id }, data: { runtimeMachineTarget: {
            homeId: await getOrCreateServerIdentityId(), accountId: owner.id, sessionId: destination.id,
            machineId: machine.id, installationId: machine.installationId!,
        } } });
        const createTurn = async (turnId: string) => {
            const terminalAt = BigInt(Date.now());
            await db.sessionTurn.create({ data: { sessionId: source.id, turnId, status: 'failed',
                startedAt: terminalAt, updatedAt: terminalAt, terminalAt } });
            return { id: turnId, status: 'failed' as const };
        };
        const first = await createTurn('admitted-before-quiet');
        await withAuthenticatedTestApp(sessionPendingRoutes, async app => {
            const send = (sourceTurn: typeof first, delivery: 'wake' | 'next_turn') => {
                const original = { sourceSessionId: source.id, sourceTurn };
                return app.inject({ method: 'POST', url: `/v2/sessions/${destination.id}/pending`,
                    headers: { 'x-test-user-id': owner.id, 'x-happier-account-stored-content-protocol': '4' }, payload: {
                        targetMachineId: machine.id, localId: deriveSessionFollowInputLocalIdV1({ destinationSessionId: destination.id, original }),
                        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `Failed ${sourceTurn.id}` } } },
                        requestedAction: { v: 1, kind: 'enqueue' }, followDeliveryV1: { v: 1, delivery, original, event: { kind: 'failed_or_stopped' } },
                        followRelations: [{ relation: 'manager', attachedAt: manager.attachedAt.getTime() }],
                        ...(privateQuiet ? { followSources: [{ rule: { ruleId, ruleVersion: 0 }, evaluation: 'receiver',
                            selectedDelivery: 'next_turn', sourceSessionId: source.id, destinationSessionId: destination.id, sourceTurn }] } : {}),
                    },
                });
            };
            const admitted = await send(first, 'wake');
            expect(admitted.statusCode, admitted.body).toBe(200);
            await db.sessionFollowEdge.update({ where: { managerSourceSessionId: source.id },
                data: { policyJson: JSON.stringify({ preset: 'quiet' }) } });
            const replay = await send(first, 'wake');
            expect(replay.statusCode, replay.body).toBe(403);
            const quiet = await send(first, 'next_turn');
            expect(quiet.statusCode, quiet.body).toBe(200);
            const later = await createTurn('first-observed-after-quiet');
            const stale = await send(later, 'wake');
            expect(stale.statusCode, stale.body).toBe(403);
            expect(await db.sessionPendingMessage.count({ where: { sessionId: destination.id } })).toBe(1);
            const nextTurn = await send(later, 'next_turn');
            expect(nextTurn.statusCode, nextTurn.body).toBe(200);
            expect(await db.sessionPendingMessage.count({ where: { sessionId: destination.id } })).toBe(2);
        });
        expect(await db.sessionMessage.count({ where: { sessionId: destination.id } })).toBe(0);
    });

    it.each(['next_turn', 'wake'] as const)('combines current manager policy with a pinned private %s vote without rewriting original custody', async selectedDelivery => {
        const owner = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        expect(await setSessionManager({ accountId: owner.id, sessionId: source.id, managerSessionId: destination.id,
            expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
        const manager = await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: source.id } });
        const ruleId = randomUUID();
        const rule = { accountId: owner.id, ruleId, authentication };
        const definition = { t: 'plain' as const, v: { v: 1 as const, enabled: true,
            filter: normalizeSessionListFilterV1({ homeServerIds: [await getOrCreateServerIdentityId()], startedBy: ['you', 'triggers', 'agents'] }),
            policy: { preset: selectedDelivery === 'wake' ? 'important' as const : 'quiet' as const } } };
        expect(await setAccountFollowRule({ ...rule, mutation: { receiver: { kind: 'session', sessionId: destination.id },
            expectedVersion: -1, content: definition } })).toMatchObject({ ok: true });
        const terminalAt = BigInt(Date.now());
        await db.sessionTurn.create({ data: { sessionId: source.id, turnId: 'private-vote-turn', status: 'failed',
            startedAt: terminalAt, updatedAt: terminalAt, terminalAt } });
        const sourceTurn = { id: 'private-vote-turn', status: 'failed' as const };
        const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'wake', event: { kind: 'failed_or_stopped' },
            original: { sourceSessionId: source.id, sourceTurn } });
        const localInputId = deriveSessionFollowInputLocalIdV1({ destinationSessionId: destination.id, original: delivery.original });
        const receipt = SessionInputAdmissionReceiptV1Schema.parse({
            ...buildSessionInputAdmissionReceipt({ issuer: 'authenticatedMachine', admittedTarget: { homeId: 'home',
                accountId: owner.id, sessionId: destination.id, machineId: 'producer', installationId: 'installation' } }),
            followDeliveryV1: delivery, followRelations: [{ relation: 'manager', attachedAt: manager.attachedAt.getTime() }],
            followSources: [{ rule: { ruleId, ruleVersion: 0 }, evaluation: 'receiver', selectedDelivery,
                sourceSessionId: source.id, destinationSessionId: destination.id, sourceTurn }],
        });
        await db.sessionMessage.create({ data: { sessionId: destination.id, seq: 1, localId: localInputId,
            messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Original failed Turn' } } },
            inputAdmissionReceipt: receipt } });
        const read = () => inTx(tx => readAdmittedSessionFollowInputInTx(tx, { principal: runtimePrincipal(owner.id),
            accountId: owner.id, destinationSessionId: destination.id, localInputId }));
        expect(await read()).toMatchObject({ effectiveDelivery: 'wake', delivery });
        await db.sessionFollowEdge.update({ where: { managerSourceSessionId: source.id }, data: { policyJson: JSON.stringify({ preset: 'quiet' }) } });
        expect(await read()).toMatchObject({ effectiveDelivery: selectedDelivery, delivery });
        const observed = await inTx(tx => observeSessionFollowForDestinationInTx(tx, { principal: runtimePrincipal(owner.id),
            destinationSessionId: destination.id, inputLocalIds: [localInputId] }));
        expect(observed.observations).toContainEqual(expect.objectContaining({ kind: 'admitted_input', localInputId,
            effectiveDelivery: selectedDelivery, delivery }));
        // A new rule version withdraws only the pinned private reason. Current
        // Quiet still selects the same immutable original for the next turn.
        expect(await setAccountFollowRule({ ...rule, mutation: { receiver: { kind: 'session', sessionId: destination.id },
            expectedVersion: 0, content: definition } })).toMatchObject({ ok: true });
        expect(await read()).toMatchObject({ effectiveDelivery: 'next_turn', delivery });
        await db.sessionFollowEdge.update({ where: { managerSourceSessionId: source.id }, data: {
            policyJson: JSON.stringify({ preset: 'custom', events: {} }),
        } });
        expect(await read()).toBeNull();
        await db.sessionMessage.update({ where: { sessionId_localId: { sessionId: destination.id, localId: localInputId } },
            data: { acceptedTurnId: 'receiver-accepted-turn', acceptedFollowOriginalKey: deriveSessionFollowOriginalOccurrenceKeyV1(delivery.original) } });
        expect(await read()).toMatchObject({ effectiveDelivery: null, nativeAccepted: true, delivery });
        const accepted = await inTx(tx => observeSessionFollowForDestinationInTx(tx, { principal: runtimePrincipal(owner.id),
            destinationSessionId: destination.id, inputLocalIds: [localInputId] }));
        expect(accepted.observations).toContainEqual(expect.objectContaining({ kind: 'admitted_input', localInputId,
            effectiveDelivery: null, delivery }));
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: {
            sessionId: destination.id, localId: localInputId,
        } } })).inputAdmissionReceipt).toEqual(receipt);
    });

    it('observes a terminal Turn without scanning its 1,000 transcript originals or destination custody', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, { seq: 1000 });
        const destination = await createSession(owner.id);
        await db.sessionMessage.createMany({ data: Array.from({ length: 1000 }, (_, index) => ({
            sessionId: source.id, seq: index + 1, localId: `original-${index}`,
            content: { t: 'plain' as const, v: { role: 'assistant', content: { type: 'text', text: 'Result' } } },
            messageRole: 'assistant',
        })) });
        expect(await setSessionManager({ accountId: owner.id, sessionId: source.id, managerSessionId: destination.id,
            expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
        await db.sessionTurn.create({ data: { sessionId: source.id, turnId: 'terminal-cost', status: 'failed',
            startedAt: 10n, updatedAt: 20n, terminalAt: 20n,
            transcriptAnchorsJson: JSON.stringify({ startSeqInclusive: 1, endSeqInclusive: 1000 }) } });
        await db.session.update({ where: { id: source.id }, data: { latestTurnId: 'terminal-cost', latestTurnStatus: 'failed' } });
        await inTx(async tx => {
            // Observe the persistent DB boundary without replacing its behavior.
            const messages = vi.spyOn(tx.sessionMessage, 'findMany');
            const pending = vi.spyOn(tx.sessionPendingMessage, 'findMany');
            try {
                const observations = await observeSessionFollowForDestinationInTx(tx, {
                    principal: runtimePrincipal(owner.id), destinationSessionId: destination.id, includeManager: true,
                });
                expect(observations.observations).toMatchObject([{ observed: { turn: { id: 'terminal-cost', status: 'failed' } } }]);
                expect(messages).toHaveBeenCalledTimes(0);
                expect(pending).toHaveBeenCalledTimes(0);
            } finally { messages.mockRestore(); pending.mockRestore(); }
        });
    });

    it('persists explicit Custom policy through set, list and observation without reseeding on a policy-only edit', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, { seq: 5 });
        const destination = await createSession(owner.id);
        const policy: FollowPolicyV1 = { preset: 'custom', events: {
            needs_you: { decision: { delivery: 'quiet' }, approval: { delivery: 'interrupt' } },
            update_posted: { delivery: 'interrupt' }, person_wrote: { delivery: 'off' },
        } };
        const input = { accountId: owner.id, sourceSessionId: source.id, destinationSessionId: destination.id, policy };
        const result = await setSessionFollowSource(input);
        expect(result).toMatchObject({ ok: true, value: { source: { policy } } });
        expect(await listSessionFollowSources({ accountId: owner.id, destinationSessionId: destination.id }))
            .toMatchObject({ ok: true, value: { sources: [{ policy }] } });
        await db.session.update({ where: { id: source.id }, data: { seq: 7 } });
        const before = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: runtimePrincipal(owner.id), destinationSessionId: destination.id,
        }));
        expect(before).toMatchObject([{ policy, delivered: { transcriptSeq: 5 }, observed: { transcriptSeq: 7 } }]);
        const updatedPolicy: FollowPolicyV1 = { preset: 'custom', events: {
            needs_you: { blocked: { delivery: 'interrupt' } }, update_posted: { delivery: 'quiet' }, message: { delivery: 'quiet' },
        } };
        expect(await setSessionFollowSource({ ...input, policy: updatedPolicy }))
            .toMatchObject({ ok: true, value: { changed: true, source: { policy: updatedPolicy } } });
        const after = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: runtimePrincipal(owner.id), destinationSessionId: destination.id,
        }));
        expect(after).toMatchObject([{ policy: updatedPolicy }]);
        expect(after.map(({ delivered, observed }) => ({ delivered, observed })))
            .toEqual(before.map(({ delivered, observed }) => ({ delivered, observed })));
        expect(await setSessionFollowSource({ ...input, policy: updatedPolicy }))
            .toMatchObject({ ok: true, value: { changed: false } });
    });

    it('creates manager relations with the canonical Important policy', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        expect((await setSessionManager({ accountId: owner.id, sessionId: source.id, managerSessionId: destination.id,
            expectedManagerSessionId: null, authentication })).ok).toBe(true);
        await db.session.update({ where: { id: source.id }, data: { seq: 1 } });
        expect(await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: runtimePrincipal(owner.id), destinationSessionId: destination.id, includeManager: true,
        }))).toMatchObject([{ relation: 'manager', policy: { preset: 'important' } }]);
    });

    it('refuses a stale policy ACK without consuming its represented original prefix', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        const policy = { preset: 'important' as const };
        const args = { accountId: owner.id, sourceSessionId: source.id, destinationSessionId: destination.id, policy };
        expect((await setSessionFollowSource(args)).ok).toBe(true);
        await db.session.update({ where: { id: source.id }, data: { seq: 2 } });
        const [observation] = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: runtimePrincipal(owner.id), destinationSessionId: destination.id,
        }));
        if (!observation || !('sourceSessionId' in observation)) throw new Error('Expected source observation');
        await db.sessionMessage.create({ data: { sessionId: destination.id, seq: 1, localId: 'accepted-policy-input',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Accepted context' } } }, messageRole: 'user' } });
        const ack = { principal: runtimePrincipal(owner.id), sourceSessionId: source.id, destinationSessionId: destination.id,
            expectedPublisherGeneration: destination.publisherGeneration, policy,
            expected: observation.delivered, observed: observation.observed, consumed: observation.observed,
            acceptance: { kind: 'admitted_input' as const, localInputId: 'accepted-policy-input', userMessageSeq: 1 } };
        expect((await setSessionFollowSource({ ...args, policy: { preset: 'quiet' } })).ok).toBe(true);
        expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, ack)))
            .toEqual({ ok: false, rejection: 'stale_expected_frontier' });
        expect(await readEdge(destination.id, source.id)).toMatchObject({ deliveredTranscriptSeq: 0 });
        expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, { ...ack, policy: { preset: 'quiet' } })))
            .toMatchObject({ ok: true, delivered: { transcriptSeq: 2 } });
    });

    it.each([{ crossAccount: false, discussion: false }, { crossAccount: true, discussion: false },
        { crossAccount: false, discussion: true }])('admits a Follow wake only while its Account-local root has check-in capacity (%j)', async ({ crossAccount, discussion }) => {
        const owner = await createAccount();
        const sourceOwner = crossAccount ? await createAccount() : owner;
        const source = await createSession(sourceOwner.id);
        const destination = await createSession(owner.id);
        if (crossAccount) await grantAccess(source, owner.id, 'view');
        expect((await setSessionFollowSource({ policy: { preset: 'everything' as const }, accountId: owner.id,
            sourceSessionId: source.id, destinationSessionId: destination.id })).ok).toBe(true);
        const originalLocalId = `original-${randomUUID()}`;
        const sourceTurnId = `source-turn-${randomUUID()}`;
        await db.sessionMessage.create({ data: {
            sessionId: source.id, localId: originalLocalId, seq: 1, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'investigate' } } },
            inputAdmissionReceipt: discussion ? { v: 1, issuer: 'authenticatedMachine',
                admittedTarget: { homeId: 'origin-home', accountId: owner.id, sessionId: source.id,
                    machineId: 'machine', installationId: 'installation' },
                discussionAddressing: { discussionId: 'origin-discussion', messageId: 'question', throughSeq: 1,
                    participantSessionId: source.id } }
                : { v: 1, issuer: 'authenticatedAccount', actorAccountId: sourceOwner.id, sessionRelationship: 'owner' },
            ...(discussion ? { autonomousExchangeRootSessionId: source.id, autonomousExchangeRootLocalId: originalLocalId } : {}),
            acceptedTurnId: sourceTurnId, acceptedTurnKind: 'newTurn',
            turnStartWitnessId: sourceTurnId,
        } });
        await db.sessionTurn.create({ data: { sessionId: source.id, turnId: sourceTurnId,
            status: 'completed', startedAt: 1n, updatedAt: 1n } });
        if (discussion) {
            // The current source input has no Discussion; only its inherited,
            // exact root receipt identifies the originating Discussion.
            await db.sessionMessage.create({ data: { sessionId: source.id, localId: 'later-follow-input', seq: 2,
                messageRole: 'user', content: { t: 'plain', v: {} }, acceptedTurnId: sourceTurnId,
                inputAdmissionReceipt: { v: 1, issuer: 'authenticatedMachine', admittedTarget: {
                    homeId: 'origin-home', accountId: owner.id, sessionId: source.id,
                    machineId: 'machine', installationId: 'installation' } },
                autonomousExchangeRootSessionId: source.id, autonomousExchangeRootLocalId: originalLocalId } });
        }
        await db.session.update({ where: { id: source.id }, data: { seq: discussion ? 2 : 1,
            latestTurnId: sourceTurnId, latestTurnStatus: 'completed' } });
        const rootSessionId = crossAccount ? destination.id : source.id;
        if (crossAccount) {
            await db.sessionMessage.create({ data: { sessionId: destination.id, localId: originalLocalId,
                seq: 1, messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'local work' } } },
                inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: owner.id, sessionRelationship: 'owner' },
                acceptedTurnId: 'receiver-turn', acceptedTurnKind: 'newTurn' } });
            await db.session.update({ where: { id: destination.id }, data: { seq: 1 } });
        }
        const observation = (await inTx(tx => observeSessionFollowForDestinationInTx(tx, {
            principal: runtimePrincipal(owner.id), destinationSessionId: destination.id,
        }))).observations.find(row => 'sourceSessionId' in row);
        if (!observation) throw new Error('Expected pending Session source');
        const observations = [{ policy: { preset: 'everything' as const }, sourceSessionId: source.id, relation: 'follower' as const,
            expected: observation.delivered, consumed: observation.observed }];
        const wakeAdmission = { eventLocalId: deriveSessionFollowWakeEventLocalIdV1({
            destinationSessionId: destination.id,
            publisherGeneration: (await loadPublisherGeneration(destination.id)).toString(),
            observations,
        }), observations, autonomousCheckIn: { afterTurns: 5 } };
        const input = { principal: runtimePrincipal(owner.id), destinationSessionId: destination.id,
            wakeAdmission };
        expect(await inTx(tx => observeSessionFollowForDestinationInTx(tx, input)))
            .toMatchObject({ wakeAdmission: { status: 'allowed' } });
        const origin = discussion ? { serverId: 'origin-home', discussionId: 'origin-discussion' } : null;
        const result = await inTx(tx => observeSessionFollowForDestinationInTx(tx, input));
        expect(SessionFollowObservePendingResponseV1Schema.parse({ ok: true, v: 1, sessionId: destination.id,
            publisherGeneration: destination.publisherGeneration.toString(), ...result }))
            .toMatchObject({ wakeAdmission: { originatingDiscussion: origin } });
        // Observation is read-only; admission may overlay the current Account
        // choice without moving the original input's control revision.
        expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: {
            sessionId: rootSessionId, localId: originalLocalId } } })).autonomousExchangeState).toBeNull();
        await db.sessionMessage.update({ where: { sessionId_localId: {
            sessionId: rootSessionId, localId: originalLocalId } }, data: {
            autonomousExchangeState: { v: 1, observedStarts: 5, pauseAtStarts: null,
                stopped: false, afterTurns: 5 },
        } });
        expect(await inTx(tx => observeSessionFollowForDestinationInTx(tx, input)))
            .toMatchObject({ wakeAdmission: { status: 'held', code: 'autonomous_check_in' } });
        expect(await inTx(tx => observeSessionFollowForDestinationInTx(tx, {
            ...input, wakeAdmission: { ...wakeAdmission, autonomousCheckIn: { afterTurns: null } },
        }))).toMatchObject({ wakeAdmission: { status: 'allowed', originatingDiscussion: origin } });
        expect(await inTx(tx => observeSessionFollowForDestinationInTx(tx, {
            ...input, wakeAdmission: { ...wakeAdmission, autonomousCheckIn: undefined },
        }))).toMatchObject({ wakeAdmission: { status: 'held', code: 'session_input_target_unavailable' } });
        await db.sessionMessage.update({ where: { sessionId_localId: {
            sessionId: rootSessionId, localId: originalLocalId } }, data: {
            autonomousExchangeState: { v: 1, observedStarts: 5, pauseAtStarts: null,
                stopped: true, afterTurns: 5 },
        } });
        expect(await inTx(tx => observeSessionFollowForDestinationInTx(tx, input)))
            .toMatchObject({ wakeAdmission: { status: 'held', code: 'session_input_cancelled' } });
        expect(await inTx(tx => observeSessionFollowForDestinationInTx(tx, {
            ...input, wakeAdmission: { ...wakeAdmission, autonomousCheckIn: { afterTurns: null } },
        }))).toMatchObject({ wakeAdmission: { status: 'held', code: 'session_input_cancelled' } });
        expect(await readEdge(destination.id, source.id)).toMatchObject({ deliveredTranscriptSeq: 0 });
        if (crossAccount) expect((await db.sessionMessage.findUniqueOrThrow({ where: { sessionId_localId: {
            sessionId: source.id, localId: originalLocalId } } })).autonomousExchangeState).toBeNull();
    });

    it('publishes one exact content-free destination invalidation after a source projection commit', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        const unrelated = await createSession(owner.id);
        await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: owner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        });

        const exactEmit = vi.fn();
        const wrongSessionEmit = vi.fn();
        const exact = {
            connectionType: 'session-scoped' as const,
            userId: owner.id,
            sessionId: destination.id,
            socket: { id: 'runner-exact', data: { authAuthority: 'present_user' }, emit: exactEmit },
        };
        const wrongSession = {
            connectionType: 'session-scoped' as const,
            userId: owner.id,
            sessionId: unrelated.id,
            socket: { id: 'runner-wrong-session', data: { authAuthority: 'present_user' }, emit: wrongSessionEmit },
        };
        // The destination broadcast is scheduled fire-and-forget
        // (`void eventRouter.emitSessionBroadcast(...)` in an after-commit
        // callback `inTx` invokes synchronously), so `vi.waitFor` resolving on
        // the first delivery does not mean the commit's fan-out has finished.
        // Settle the emitter's own promises to a fixpoint rather than waiting a
        // guessed interval: anything still in flight would otherwise land after
        // `mockClear()` and read as an emission from the rolled-back commit.
        const broadcast = vi.spyOn(eventRouter, 'emitSessionBroadcast');
        const settleBroadcasts = async () => {
            for (let settled = -1; settled !== broadcast.mock.results.length;) {
                settled = broadcast.mock.results.length;
                await Promise.all(broadcast.mock.results.map(
                    (result) => result.type === 'return' ? result.value : undefined,
                ));
            }
        };
        eventRouter.addConnection(owner.id, exact as never);
        eventRouter.addConnection(owner.id, wrongSession as never);
        try {
            const before = await db.accountChange.findFirst({ where: { accountId: owner.id, entityId: destination.id }, orderBy: { cursor: 'desc' } });
            await inTx(async (tx) => {
                await tx.session.update({ where: { id: source.id }, data: { seq: { increment: 1 } } });
                await markSessionProjectionRecipientsChanged({ tx, sessionId: source.id });
            });
            await vi.waitFor(() => expect(exactEmit).toHaveBeenCalledWith('session', expect.objectContaining({
                body: { t: 'session-changed', sessionId: destination.id },
            })));
            await settleBroadcasts();
            expect(await db.accountChange.findFirst({ where: { accountId: owner.id, entityId: destination.id,
                cursor: { gt: before?.cursor ?? 0 } } })).not.toBeNull();
            expect(wrongSessionEmit).not.toHaveBeenCalled();

            exactEmit.mockClear();
            await expect(inTx(async (tx) => {
                await tx.session.update({ where: { id: source.id }, data: { seq: { increment: 1 } } });
                await markSessionProjectionRecipientsChanged({ tx, sessionId: source.id });
                throw new Error('rollback');
            })).rejects.toThrow('rollback');
            await settleBroadcasts();
            expect(exactEmit).not.toHaveBeenCalled();
        } finally {
            broadcast.mockRestore();
            eventRouter.removeConnection(owner.id, exact as never);
            eventRouter.removeConnection(owner.id, wrongSession as never);
        }
    });

    afterAll(async () => {
        if (harness) await harness.close();
    });

    it('invalidates an overlapping manager and follower destination once per source commit', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        await db.sessionFollowEdge.createMany({ data: [
            { policyJson: '{"preset":"everything"}', sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: source.id }), sourceSessionId: source.id, destinationSessionId: destination.id, relation: 'follower' },
            { policyJson: '{"preset":"important"}', sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: source.id }), sourceSessionId: source.id, destinationSessionId: destination.id, relation: 'manager', managerSourceSessionId: source.id },
        ] });
        const before = await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } });
        await inTx(async tx => {
            await tx.session.update({ where: { id: source.id }, data: { seq: { increment: 1 } } });
            await markSessionProjectionRecipientsChanged({ tx, sessionId: source.id });
        });
        // Source and destination each project once, with one independently
        // coalesced Follow wake even when two relations share the receiver.
        expect(await db.account.findUniqueOrThrow({ where: { id: owner.id }, select: { seq: true } }))
            .toEqual({ seq: before.seq + 3 });
        expect(await db.accountChange.findMany({ where: { accountId: owner.id }, select: { entityId: true }, orderBy: { entityId: 'asc' } }))
            .toEqual([source.id, destination.id, buildSessionFollowReceiverChangeEntityIdV1(destination.id)]
                .sort().map(entityId => ({ entityId })));
    });

    it.each(['plain', 'e2ee'] as const)(
        'projects only the current edge-delivered to server-observed transcript range for a %s source and the current materialized Runner tuple',
        async (encryptionMode) => {
        const owner = await createAccount();
        const agentState = encryptionMode === 'plain' ? JSON.stringify({ requests: {} }) : 'encrypted-current-agent-state';
        const source = await createSession(owner.id, { seq: 2, encryptionMode, agentState });
        const sibling = await createSession(owner.id, { seq: 2 });
        const destination = await createSession(owner.id);
        await setSessionFollowSource({ policy: { preset: 'everything' as const }, accountId: owner.id, sourceSessionId: source.id, destinationSessionId: destination.id });
        await db.sessionMessage.create({ data: {
            sessionId: source.id,
            seq: 2,
            content: encryptionMode === 'plain'
                ? { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'bounded' } } }
                : { t: 'encrypted', c: 'Ym91bmRlZA' },
        } });
        const publicKey = new Uint8Array(32).fill(7);
        const machine = await db.machine.create({ data: {
            id: `runner-${randomUUID()}`, accountId: owner.id, metadata: '{}', kind: 'ephemeral_session_runner',
            installationId: 'runner-installation', installationPublicKey: publicKey,
        } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId: machine.id, sessionId: destination.id, data: 'opaque' } });
        const activationId = randomUUID();
        await db.ephemeralRunnerActivation.create({ data: {
            id: activationId, creatorAccountId: owner.id, creatorTokenEpoch: owner.tokenEpoch, draftId: `draft-${randomUUID()}`,
            sessionId: destination.id, machineId: machine.id, state: 'materialized', workspacePolicy: 'choose_on_endpoint', homeServerIdentityId: 'home',
            activationSigningPublicKey: 'a'.repeat(43), authoringCommitment: 'b'.repeat(43),
            artifact: {}, endpointFactsRecipient: {},
        } });
        const principal = {
            kind: 'ephemeral_session_runner' as const, authority: 'session_runtime' as const, accountId: owner.id,
            activationId, sessionId: destination.id, machineId: machine.id, installationId: 'runner-installation',
            installationPublicKey: encodeBase64(publicKey, 'base64url'), creatorTokenEpoch: owner.tokenEpoch,
        };
        const historicalRequest = { relation: 'follower' as const, v: 1 as const, sourceSessionId: source.id, afterTranscriptSeq: 1, observedTranscriptSeq: 2, limit: 20 };

        // The edge was seeded at source seq=2. A Runner must not widen the
        // lower bound to replay history that predates the Follow relation.
        await expect(inTx((tx) => projectSessionFollowSourceForRunnerInTx(tx, {
            principal, destinationSessionId: destination.id, request: historicalRequest,
        }))).resolves.toBeNull();
        // Nor may it widen the upper bound beyond the source frontier that the
        // server can currently observe for this edge.
        await expect(inTx((tx) => projectSessionFollowSourceForRunnerInTx(tx, {
            principal,
            destinationSessionId: destination.id,
            request: { ...historicalRequest, afterTranscriptSeq: 2, observedTranscriptSeq: 3 },
        }))).resolves.toBeNull();
        await expect(inTx((tx) => projectSessionFollowSourceForRunnerInTx(tx, {
            principal, destinationSessionId: destination.id, request: { ...historicalRequest, sourceSessionId: sibling.id },
        }))).resolves.toBeNull();
        await db.sessionMessage.create({ data: {
            sessionId: source.id,
            seq: 3,
            localId: 'runner-original-3',
            content: encryptionMode === 'plain'
                ? { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'current' } } }
                : { t: 'encrypted', c: 'Y3VycmVudA' },
        } });
        await db.session.update({ where: { id: source.id }, data: { seq: 3 } });
        await expect(inTx((tx) => observeSessionFollowForDestinationInTx(tx, {
            principal,
            destinationSessionId: destination.id,
        }))).resolves.toMatchObject({
            currentSourceSessionIds: [source.id],
            observations: [{ sourceSessionId: source.id, observed: { transcriptSeq: 3 } }],
        });
        await expect(inTx((tx) => projectSessionFollowSourceForRunnerInTx(tx, {
            principal,
            destinationSessionId: destination.id,
            request: { ...historicalRequest, afterTranscriptSeq: 2, observedTranscriptSeq: 2 },
        }))).resolves.toMatchObject({ source: { id: source.id }, messages: [], hasMore: false });
        // A wake scan continues past a full page from a cursor beyond the delivered
        // frontier (09D §6.3 "that exact new range"). That never replays history at
        // or below the frontier, so the continuation is admitted and still bounded
        // by the same observed ceiling.
        await expect(inTx((tx) => projectSessionFollowSourceForRunnerInTx(tx, {
            principal,
            destinationSessionId: destination.id,
            request: { ...historicalRequest, afterTranscriptSeq: 3, observedTranscriptSeq: 3 },
        }))).resolves.toMatchObject({ source: { id: source.id }, messages: [], hasMore: false });
        const request = { ...historicalRequest, afterTranscriptSeq: 2, observedTranscriptSeq: 3 };
        await expect(inTx((tx) => projectSessionFollowSourceForRunnerInTx(tx, {
            principal, destinationSessionId: destination.id, request,
        }))).resolves.toMatchObject({ source: { id: source.id, agentState }, messages: [{ seq: 3, localId: 'runner-original-3' }], hasMore: false });

        // Stored transcript reads preserve historical ids; only original
        // admission applies the current Pending identity grammar.
        await db.sessionMessage.updateMany({ where: { sessionId: source.id, seq: 3 }, data: { localId: '' } });
        await expect(inTx((tx) => projectSessionFollowSourceForRunnerInTx(tx, {
            principal, destinationSessionId: destination.id, request,
        }))).resolves.toMatchObject({ messages: [{ seq: 3, localId: '' }] });

        // If another accepted input advances the edge before this projection
        // request arrives, the stale request must not replay that consumed row.
        await db.sessionFollowEdge.update({
            where: { destinationSessionId_sourceSessionId_relation: {
                destinationSessionId: destination.id,
                sourceSessionId: source.id,
                relation: 'follower',
            } },
            data: { deliveredTranscriptSeq: 3 },
        });
        await expect(inTx((tx) => projectSessionFollowSourceForRunnerInTx(tx, {
            principal, destinationSessionId: destination.id, request,
        }))).resolves.toBeNull();
        // A manager uses the same incremental reader. Both relations may
        // coexist, and its attachment marker fences reattachment separately.
        await db.sessionFollowEdge.create({ data: { policyJson: '{"preset":"important"}', sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: source.id }), sourceSessionId: source.id, destinationSessionId: destination.id,
            relation: 'manager', managerSourceSessionId: source.id,
            attachedAt: new Date(100), deliveredTranscriptSeq: 3 } });
        const managerRequest = { v: 1 as const, sourceSessionId: source.id,
            relation: 'manager' as const, attachedAt: 100,
            readMode: 'incremental' as const, afterTranscriptSeq: 3, observedTranscriptSeq: 3, limit: 1 };
        await expect(inTx((tx) => projectSessionFollowSourceForRunnerInTx(tx, {
            principal, destinationSessionId: destination.id, request: managerRequest,
        }))).resolves.toMatchObject({ source: { id: source.id }, messages: [], hasMore: false });
        const runtimeIssueV1 = { v: 1, scope: 'primary_session', status: 'failed', code: 'usage_limit', source: 'usage_limit',
            occurredAt: 1000, usageLimit: { v: 1, resetAtMs: 1_800_000, retryAfterMs: null, quotaScope: 'provider', recoverability: 'wait' } };
        await db.session.update({ where: { id: source.id }, data: { latestTurnId: 'failed-turn', latestTurnStatus: 'failed',
            lastRuntimeIssue: JSON.stringify(runtimeIssueV1) } });
        await expect(inTx((tx) => projectSessionFollowSourceForRunnerInTx(tx, {
            principal, destinationSessionId: destination.id, request: managerRequest,
        }))).resolves.toMatchObject({ source: { latestTurnId: 'failed-turn', lastRuntimeIssue: runtimeIssueV1 } });
        await db.sessionFollowEdge.update({ where: { managerSourceSessionId: source.id }, data: { attachedAt: new Date(101) } });
        await expect(inTx((tx) => projectSessionFollowSourceForRunnerInTx(tx, {
            principal, destinationSessionId: destination.id, request: managerRequest,
        }))).resolves.toBeNull();

        const { encryptWithDataKey, decryptWithDataKeyResult } = await vi.importActual<{
            encryptWithDataKey(value: unknown, key: Uint8Array): Uint8Array;
            decryptWithDataKeyResult(value: Uint8Array, key: Uint8Array): { status: string; value?: unknown };
        }>('../../../../../cli/src/api/encryption');
        const sourceKey = new Uint8Array(32).fill(23);
        const finalContent = { role: 'agent', content: { type: 'text', text: 'Exact anchored terminal result' } };
        const storedFinal = encryptionMode === 'plain' ? { t: 'plain' as const, v: finalContent }
            : { t: 'encrypted' as const, c: encodeBase64(encryptWithDataKey(finalContent, sourceKey)) };
        const finalMessage = await db.sessionMessage.create({ data: { sessionId: source.id, seq: 4, localId: 'exact-terminal-result',
            messageRole: 'agent', content: storedFinal } });
        await db.sessionMessage.create({ data: { sessionId: source.id, seq: 5, localId: 'unanchored-terminal-neighbor',
            messageRole: 'agent', content: encryptionMode === 'plain'
                ? { t: 'plain', v: { role: 'agent', content: { type: 'text', text: 'Unanchored private neighbor' } } }
                : { t: 'encrypted', c: encodeBase64(encryptWithDataKey({ role: 'agent', content: {
                    type: 'text', text: 'Unanchored private neighbor',
                } }, sourceKey)) } } });
        await db.session.update({ where: { id: source.id }, data: { seq: 5 } });
        const terminal = await db.sessionTurn.create({ data: { sessionId: source.id, turnId: 'exact-terminal', status: 'completed',
            startedAt: 1n, updatedAt: 2n, terminalAt: 2n,
            transcriptAnchorsJson: JSON.stringify({ startSeqInclusive: 3, endSeqInclusive: 4, finalAssistantMessageSeq: 4 }) } });
        const delivery = SessionFollowInputV1Schema.parse({ v: 1, delivery: 'next_turn', event: { kind: 'finished' },
            original: { sourceSessionId: source.id, sourceTurn: { id: terminal.turnId, status: 'completed' } } });
        const localInputId = deriveSessionFollowInputLocalIdV1({ destinationSessionId: destination.id, original: delivery.original });
        const receipt = SessionInputAdmissionReceiptV1Schema.parse({
            ...buildSessionInputAdmissionReceipt({ issuer: 'authenticatedMachine', admittedTarget: {
                homeId: 'home', accountId: owner.id, sessionId: destination.id,
                machineId: machine.id, installationId: 'runner-installation',
            } }), followRelations: [{ relation: 'follower' }], followDeliveryV1: delivery,
        });
        await db.sessionMessage.create({ data: { sessionId: destination.id, seq: 1, localId: localInputId, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Admitted terminal notice' } } },
            inputAdmissionReceipt: receipt } });
        const terminalRequest = { v: 1 as const, sourceSessionId: source.id, relation: 'follower' as const,
            localInputId, afterTranscriptSeq: 0, observedTranscriptSeq: 0, limit: 1 };
        const projectTerminal = () => inTx(tx => projectSessionFollowSourceForRunnerInTx(tx, {
            principal, destinationSessionId: destination.id, request: terminalRequest,
        }));
        const projectedTerminal = await projectTerminal();
        expect(projectedTerminal).toMatchObject({ source: { lastRuntimeIssue: null },
            messages: [{ seq: 4, localId: 'exact-terminal-result', content: storedFinal }], hasMore: false });
        expect(projectedTerminal!.messages).toHaveLength(1);
        const content = projectedTerminal!.messages[0]!.content;
        expect(content.t === 'plain' ? content.v : decryptWithDataKeyResult(decodeBase64(content.c), sourceKey).value).toEqual(finalContent);
        await db.sessionMessage.update({ where: { id: finalMessage.id }, data: { content: encryptionMode === 'plain'
            ? { t: 'encrypted', c: encodeBase64(encryptWithDataKey(finalContent, sourceKey)) }
            : { t: 'plain', v: finalContent } } });
        expect(await projectTerminal()).toBeNull();
        await db.sessionMessage.update({ where: { id: finalMessage.id }, data: { content: storedFinal } });
        await db.sessionMessage.update({ where: { id: finalMessage.id }, data: { sidechainId: 'private-run' } });
        expect(await projectTerminal()).toMatchObject({ messages: [], hasMore: false });
        await db.sessionMessage.update({ where: { id: finalMessage.id }, data: { sidechainId: null } });
        await db.sessionTurn.update({ where: { id: terminal.id }, data: { transcriptAnchorsJson: JSON.stringify({
            startSeqInclusive: 3, endSeqInclusive: 4,
        }) } });
        expect(await projectTerminal()).toMatchObject({ messages: [], hasMore: false });
        await db.sessionTurn.update({ where: { id: terminal.id }, data: { status: 'failed' } });
        expect(await projectTerminal()).toBeNull();
        await db.machine.update({ where: { id: machine.id }, data: { revokedAt: new Date() } });
        await expect(inTx((tx) => projectSessionFollowSourceForRunnerInTx(tx, { principal, destinationSessionId: destination.id, request })))
            .resolves.toBeNull();
        await expect(inTx((tx) => observeSessionFollowForDestinationInTx(tx, {
            principal,
            destinationSessionId: destination.id,
        }))).resolves.toEqual({ currentSourceSessionIds: [], observations: [] });
        await expect(inTx((tx) => acknowledgeSessionFollowFrontierInTx(tx, { policy: { preset: 'everything' as const },
            principal,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
            expectedPublisherGeneration: destination.publisherGeneration,
            expected: { transcriptSeq: 2, readyEventSeq: 0, agentStateVersion: 0, turn: null },
            observed: { transcriptSeq: 3, readyEventSeq: 0, agentStateVersion: 0, turn: null },
            consumed: { transcriptSeq: 3, readyEventSeq: 0, agentStateVersion: 0, turn: null },
            acceptance: { kind: 'admitted_input', localInputId: 'runner-input', userMessageSeq: null },
        }))).resolves.toEqual({ ok: false, rejection: 'source_forbidden' });
    });


    it('does not re-offer an acknowledged waiting manager turn after reloading its persisted frontier', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, { active: true, latestTurnId: 'question-turn', latestTurnStatus: 'in_progress' });
        const destination = await createSession(owner.id);
        expect(await setSessionManager({ accountId: owner.id, sessionId: source.id, managerSessionId: destination.id,
            expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
        await db.session.update({ where: { id: source.id }, data: { latestTurnStatus: 'waiting', agentStateVersion: 1 } });
        const observe = () => inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            destinationSessionId: destination.id, principal: runtimePrincipal(owner.id), includeManager: true,
        }));
        const pending = (await observe()).find(row => 'relation' in row && row.relation === 'manager');
        expect(pending?.observed.turn).toEqual({ id: 'question-turn', status: 'waiting' });
        if (!pending || !('relation' in pending)) throw new Error('Expected the new waiting manager occurrence');
        await db.sessionMessage.create({ data: { sessionId: destination.id, seq: 1, localId: 'accepted-wait-input',
            messageRole: 'user', content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Handle the question' } } },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: owner.id, sessionRelationship: 'owner' },
        } });
        const generation = await loadPublisherGeneration(destination.id);
        expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, {
            principal: runtimePrincipal(owner.id), destinationSessionId: destination.id, sourceSessionId: source.id,
            relation: 'manager', attachedAt: pending.attachedAt,
            expectedPublisherGeneration: generation,
            expected: pending.delivered, observed: pending.observed, consumed: pending.observed,
            acceptance: { kind: 'admitted_input', localInputId: 'accepted-wait-input', userMessageSeq: 1 },
        }))).toMatchObject({ ok: true });
        expect(await db.sessionFollowEdge.findUniqueOrThrow({ where: { managerSourceSessionId: source.id } }))
            .toMatchObject({ deliveredTurnId: 'question-turn', deliveredTurnStatus: 'waiting', deliveredAgentStateVersion: 1 });
        // A restarted manager has only persisted source/edge facts. These fresh
        // transactions deliberately retain no in-memory accepted-turn identity.
        await db.session.update({ where: { id: destination.id }, data: { publisherGeneration: { increment: 1n } } });
        expect(await observe()).toEqual([]);
    });

    it('preserves a stalled turn and rejects invalid persisted terminal-turn frontiers', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);

        const sourceKey = `session:${source.id}`;
        const policyJson = JSON.stringify({ preset: 'everything' });
        await db.$executeRaw`
            INSERT INTO SessionFollowEdge (
                sourceKey,
                policyJson,
                sourceSessionId,
                destinationSessionId,
                deliveredTurnId,
                deliveredTurnStatus
            ) VALUES (${sourceKey}, ${policyJson}, ${source.id}, ${destination.id}, ${'stalled-turn'}, NULL)
        `;
        expect(await readEdge(destination.id, source.id)).toMatchObject({ deliveredTurnId: 'stalled-turn', deliveredTurnStatus: null });
        await db.sessionFollowEdge.deleteMany({ where: { sourceSessionId: source.id, destinationSessionId: destination.id } });

        await expect(db.$executeRaw`
            INSERT INTO SessionFollowEdge (
                sourceKey,
                policyJson,
                sourceSessionId,
                destinationSessionId,
                deliveredTurnId,
                deliveredTurnStatus
            ) VALUES (${sourceKey}, ${policyJson}, ${source.id}, ${destination.id}, NULL, ${'completed'})
        `).rejects.toThrow();

        await expect(db.$executeRaw`
            INSERT INTO SessionFollowEdge (
                sourceKey,
                policyJson,
                sourceSessionId,
                destinationSessionId,
                deliveredTurnId,
                deliveredTurnStatus
            ) VALUES (${sourceKey}, ${policyJson}, ${source.id}, ${destination.id}, ${'turn-invalid-status'}, ${'running'})
        `).rejects.toThrow();

        expect(await readEdge(destination.id, source.id)).toBeNull();
    });

    it('rejects a persisted self-follow edge', async () => {
        const owner = await createAccount();
        const session = await createSession(owner.id);

        await expect(db.$executeRaw`
            INSERT INTO SessionFollowEdge (
                sourceKey,
                policyJson,
                sourceSessionId,
                destinationSessionId
            ) VALUES (${`session:${session.id}`}, ${JSON.stringify({ preset: 'everything' })}, ${session.id}, ${session.id})
        `).rejects.toThrow();

        expect(await readEdge(session.id, session.id)).toBeNull();
    });

    it.each([
        'deliveredTranscriptSeq',
        'deliveredReadyEventSeq',
        'deliveredAgentStateVersion',
    ] as const)('rejects a negative persisted %s', async (column) => {
        const owner = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);

        await expect(db.$executeRawUnsafe(
            `INSERT INTO SessionFollowEdge (sourceKey, policyJson, sourceSessionId, destinationSessionId, ${column}) VALUES (?, ?, ?, ?, -1)`,
            `session:${source.id}`,
            JSON.stringify({ preset: 'everything' }),
            source.id,
            destination.id,
        )).rejects.toThrow();

        expect(await readEdge(destination.id, source.id)).toBeNull();
    });

    it('seeds every delivered component from the current source frontier so enabling Follow delivers no history', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, SEEDED_SOURCE);
        const destination = await createSession(owner.id);

        const result = await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: owner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        });

        expect(result).toEqual({
            ok: true,
            value: {
                changed: true,
                source: {
                    sourceSessionId: source.id,
                    destinationSessionId: destination.id,
                    policy: { preset: 'everything' as const },
                    deliveryState: 'eligible',
                    hasPendingUpdates: false,
                },
            },
        });
        expect(await readEdge(destination.id, source.id)).toMatchObject({
            deliveredTranscriptSeq: 5,
            deliveredReadyEventSeq: 3,
            deliveredAgentStateVersion: 2,
            deliveredTurnId: 'turn-a',
            deliveredTurnStatus: 'completed',
        });
        expect(await inTx((tx: Tx) => observePendingSessionFollowForDestinationInTx(tx, {
            destinationSessionId: destination.id,
            principal: runtimePrincipal(owner.id),
        }))).toEqual([]);
    });

    it.each(['follow', 'reports_to'] as const)('admits key preparation only for the current %s edge and exact ephemeral destination AccessKey', async (edgeKind) => {
        const owner = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        if (edgeKind === 'follow') {
            await setSessionFollowSource({ policy: { preset: 'everything' as const }, accountId: owner.id, sourceSessionId: source.id, destinationSessionId: destination.id });
        } else {
            await db.sessionFollowEdge.create({ data: { policyJson: '{"preset":"important"}', sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: source.id }), sourceSessionId: source.id, destinationSessionId: destination.id,
                relation: 'manager', managerSourceSessionId: source.id } });
            expect(await readEdge(destination.id, source.id)).toBeNull();
        }
        const installationId = `installation-${randomUUID()}`;
        await expect(authorizeSessionFollowSourceKeyPreparer({
            accountId: owner.id, sourceSessionId: source.id, destinationSessionId: destination.id,
            authentication, localInputId: 'not-admitted',
        })).resolves.toMatchObject({ ok: false });
        const installationPublicKey = new Uint8Array(32).fill(9);
        const runner = await db.machine.create({ data: {
            id: `runner-${randomUUID()}`,
            accountId: owner.id,
            kind: 'ephemeral_session_runner',
            metadata: '{}',
            dataEncryptionKey: new Uint8Array([1]),
            runnerContentKeyBinding: {},
            installationId,
            installationPublicKey,
        } });
        const persistent = await db.machine.create({ data: {
            id: `persistent-${randomUUID()}`,
            accountId: owner.id,
            kind: 'persistent',
            metadata: '{}',
        } });
        await db.accessKey.create({ data: {
            accountId: owner.id,
            machineId: runner.id,
            sessionId: destination.id,
            data: 'opaque',
        } });

        const activationId = randomUUID();
        const principal = {
            kind: 'ephemeral_session_runner' as const,
            authority: 'session_runtime' as const,
            accountId: owner.id,
            activationId,
            sessionId: destination.id,
            machineId: runner.id,
            installationId,
            installationPublicKey: encodeBase64(installationPublicKey, 'base64url'),
            creatorTokenEpoch: owner.tokenEpoch,
        };
        if (edgeKind === 'follow') {
            await expect(authorizeSessionFollowSourceKeyPreparation({
                accountId: owner.id,
                sourceSessionId: source.id,
                destinationSessionId: destination.id,
                principal,
            })).resolves.toEqual({ ok: false, error: 'session_follow_source_forbidden' });
        }
        await db.ephemeralRunnerActivation.create({ data: {
            id: activationId, creatorAccountId: owner.id, creatorTokenEpoch: owner.tokenEpoch, draftId: `draft-${randomUUID()}`,
            sessionId: destination.id, machineId: runner.id, state: 'materialized', workspacePolicy: 'choose_on_endpoint', homeServerIdentityId: 'home',
            activationSigningPublicKey: 'a'.repeat(43), authoringCommitment: 'b'.repeat(43),
            artifact: {}, endpointFactsRecipient: {},
        } });
        await expect(authorizeSessionFollowSourceKeyPreparation({
            accountId: owner.id,
            sourceSessionId: source.id,
            destinationSessionId: destination.id,
            principal,
        })).resolves.toMatchObject({ ok: true, value: { destinationRuntimeAccountId: owner.id, machineId: runner.id } });
        await db.account.update({ where: { id: owner.id }, data: { tokenEpoch: { increment: 1 } } });
        await expect(authorizeSessionFollowSourceKeyPreparation({
            accountId: owner.id,
            sourceSessionId: source.id,
            destinationSessionId: destination.id,
            principal,
        })).resolves.toEqual({ ok: false, error: 'session_follow_source_forbidden' });
        await db.account.update({ where: { id: owner.id }, data: { tokenEpoch: principal.creatorTokenEpoch } });
        await expect(authorizeSessionFollowSourceKeyPreparation({
            accountId: owner.id,
            sourceSessionId: source.id,
            destinationSessionId: destination.id,
            principal: { ...principal, installationId: `sibling-${installationId}` },
        })).resolves.toEqual({ ok: false, error: 'session_follow_source_forbidden' });
        await db.machine.update({
            where: { id: runner.id },
            data: {
                dataEncryptionKey: new Uint8Array(Buffer.from(MACHINE_PLAIN_DATA_KEY_MARKER, 'base64')),
            },
        });
        await expect(authorizeSessionFollowSourceKeyPreparation({
            accountId: owner.id,
            sourceSessionId: source.id,
            destinationSessionId: destination.id,
            principal,
        })).resolves.toEqual({ ok: false, error: 'session_follow_source_forbidden' });
        await db.machine.update({
            where: { id: runner.id },
            data: { dataEncryptionKey: new Uint8Array([1]), runnerContentKeyBinding: {} },
        });
        await expect(authorizeSessionFollowSourceKeyPreparation({
            accountId: owner.id,
            sourceSessionId: source.id,
            destinationSessionId: destination.id,
            principal: { ...principal, machineId: persistent.id },
        })).resolves.toEqual({ ok: false, error: 'session_follow_source_forbidden' });

        await db.accessKey.deleteMany({ where: { machineId: runner.id } });
        await expect(authorizeSessionFollowSourceKeyPreparation({
            accountId: owner.id,
            sourceSessionId: source.id,
            destinationSessionId: destination.id,
            principal,
        })).resolves.toEqual({ ok: false, error: 'session_follow_source_forbidden' });

        if (edgeKind === 'follow') {
            await db.sessionFollowEdge.deleteMany({ where: { sourceSessionId: source.id } });
        } else {
            const otherLead = await createSession(owner.id);
            await db.sessionFollowEdge.update({ where: { managerSourceSessionId: source.id }, data: { destinationSessionId: otherLead.id } });
        }
        await expect(authorizeSessionFollowSourceKeyPreparation({
            accountId: owner.id, sourceSessionId: source.id, destinationSessionId: destination.id, principal,
        })).resolves.toEqual({ ok: false, error: 'session_not_found' });
    });

    it.each(['follow', 'reports_to'] as const)('requires the %s destination Account grant even when its edge author is authorized', async (edgeKind) => {
        const sourceOwner = await createAccount();
        const destinationOwner = await createAccount();
        const source = await createSession(sourceOwner.id);
        const destination = await createSession(destinationOwner.id);
        await grantAccess(source, destinationOwner.id, 'view');
        await grantAccess(destination, sourceOwner.id, 'edit');
        if (edgeKind === 'follow') {
            await setSessionFollowSource({ policy: { preset: 'everything' as const }, accountId: sourceOwner.id, sourceSessionId: source.id, destinationSessionId: destination.id });
        } else {
            await db.sessionFollowEdge.create({ data: { policyJson: '{"preset":"important"}', sourceKey: sourceKeyForSessionFollowSourceV1({ kind: 'session', sessionId: source.id }), sourceSessionId: source.id, destinationSessionId: destination.id,
                relation: 'manager', managerSourceSessionId: source.id } });
        }
        const installationId = `installation-${randomUUID()}`;
        const installationPublicKey = new Uint8Array(32).fill(8);
        const runner = await db.machine.create({ data: {
            id: `runner-${randomUUID()}`,
            accountId: destinationOwner.id,
            kind: 'ephemeral_session_runner',
            metadata: '{}',
            dataEncryptionKey: new Uint8Array([1]),
            runnerContentKeyBinding: {},
            installationId,
            installationPublicKey,
        } });
        await db.accessKey.create({ data: {
            accountId: destinationOwner.id,
            machineId: runner.id,
            sessionId: destination.id,
            data: 'opaque',
        } });

        const activationId = randomUUID();
        await db.ephemeralRunnerActivation.create({ data: {
            id: activationId,
            creatorAccountId: destinationOwner.id,
            creatorTokenEpoch: destinationOwner.tokenEpoch,
            draftId: `draft-${randomUUID()}`,
            sessionId: destination.id,
            machineId: runner.id,
            state: 'materialized',
            workspacePolicy: 'choose_on_endpoint',
            homeServerIdentityId: 'home',
            activationSigningPublicKey: 'a'.repeat(43),
            authoringCommitment: 'b'.repeat(43),
            artifact: {},
            endpointFactsRecipient: {},
        } });

        const principal = {
            kind: 'ephemeral_session_runner' as const,
            authority: 'session_runtime' as const,
            accountId: destinationOwner.id,
            activationId,
            sessionId: destination.id,
            machineId: runner.id,
            installationId,
            installationPublicKey: encodeBase64(installationPublicKey, 'base64url'),
            creatorTokenEpoch: destinationOwner.tokenEpoch,
        };
        await expect(authorizeSessionFollowSourceKeyPreparation({
            accountId: sourceOwner.id,
            sourceSessionId: source.id,
            destinationSessionId: destination.id,
            principal,
        })).resolves.toEqual({ ok: false, error: 'session_follow_source_forbidden' });
        await expect(authorizeSessionFollowSourceKeyPreparation({
            accountId: destinationOwner.id, sourceSessionId: source.id, destinationSessionId: destination.id, principal,
        })).resolves.toMatchObject({ ok: true, value: { destinationRuntimeAccountId: destinationOwner.id, machineId: runner.id } });
        await db.sessionShare.deleteMany({ where: { sessionId: source.id, sharedWithUserId: destinationOwner.id } });
        await expect(authorizeSessionFollowSourceKeyPreparation({
            accountId: destinationOwner.id, sourceSessionId: source.id, destinationSessionId: destination.id, principal,
        })).resolves.toEqual({ ok: false, error: 'session_follow_source_forbidden' });
    });

    it('treats a null ready sequence as the pre-ready zero frontier and the first positive sequence as pending', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, { latestReadyEventSeq: null });
        const destination = await createSession(owner.id);

        await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: owner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        });
        expect(await readEdge(destination.id, source.id)).toMatchObject({ deliveredReadyEventSeq: 0 });
        expect(await inTx((tx: Tx) => observePendingSessionFollowForDestinationInTx(tx, {
            destinationSessionId: destination.id,
            principal: runtimePrincipal(owner.id),
        }))).toEqual([]);

        await db.session.update({ where: { id: source.id }, data: { latestReadyEventSeq: 1 } });
        const pending = await inTx((tx: Tx) => observePendingSessionFollowForDestinationInTx(tx, {
            destinationSessionId: destination.id,
            principal: runtimePrincipal(owner.id),
        }));
        expect(pending).toHaveLength(1);
        expect(pending[0]?.observed.readyEventSeq).toBe(1);
    });

    it('keeps muted manager and ordinary originals reachable for suppression without muting another receiver', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, { latestReadyEventSeq: null });
        const destination = await createSession(owner.id);
        const otherDestination = await createSession(owner.id);
        await setSessionFollowSource({ policy: { preset: 'everything' as const }, accountId: owner.id, destinationSessionId: destination.id, sourceSessionId: source.id });
        expect(await setSessionManager({ accountId: owner.id, sessionId: source.id, managerSessionId: destination.id,
            expectedManagerSessionId: null, authentication })).toMatchObject({ ok: true });
        await setSessionFollowSource({ policy: { preset: 'everything' as const }, accountId: owner.id, destinationSessionId: otherDestination.id, sourceSessionId: source.id });
        await db.session.update({ where: { id: source.id }, data: { latestReadyEventSeq: 1 } });
        const observe = async (destinationSessionId = destination.id) => (await inTx((tx: Tx) => observePendingSessionFollowForDestinationInTx(tx, {
            destinationSessionId, principal: runtimePrincipal(owner.id), includeManager: true,
        }))).map(observation => {
            if (!('relation' in observation)) throw new Error('Expected Session Follow edge progress');
            return observation;
        });
        expect((await observe()).map(row => row.relation).sort()).toEqual(['follower', 'manager']);
        const change = (operation: 'set' | 'remove') => changeDeliveryMute({ accountId: owner.id,
            receiver: { kind: 'session', sessionId: destination.id },
            scope: { kind: 'sender_session', sessionId: source.id }, operation, authentication });
        expect(await change('set')).toMatchObject({ ok: true, value: { changed: true } });
        expect((await observe()).map(row => row.relation).sort()).toEqual(['follower', 'manager']);
        expect(await observe(otherDestination.id)).toHaveLength(1);
        expect((await readEdge(destination.id, source.id))?.deliveredReadyEventSeq).toBe(0);
        expect((await db.sessionFollowEdge.findUniqueOrThrow({ where: { destinationSessionId_sourceSessionId_relation: {
            destinationSessionId: destination.id, sourceSessionId: source.id, relation: 'manager',
        } } })).deliveredReadyEventSeq).toBe(0);
        expect(await change('remove')).toMatchObject({ ok: true, value: { changed: true } });
        expect((await observe()).map(row => row.relation).sort()).toEqual(['follower', 'manager']);
    });

    it('rejects the same Session, unreadable endpoints, missing destination input, archived endpoints and a denied pairwise flow', async () => {
        const owner = await createAccount();
        const stranger = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        const archived = await createSession(owner.id, { archivedAt: new Date() });

        expect(await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: owner.id,
            destinationSessionId: destination.id,
            sourceSessionId: destination.id,
        })).toEqual({ ok: false, error: 'session_follow_same_session' });

        expect(await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: stranger.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        })).toEqual({ ok: false, error: 'session_not_found' });

        // Readable source and destination, but only `view` on the destination:
        // the destination-input capability is missing, so this is a forbidden
        // flow rather than a concealed Session.
        const viewer = await createAccount();
        await grantAccess(source, viewer.id, 'view');
        await grantAccess(destination, viewer.id, 'view');
        expect(await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: viewer.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        })).toEqual({ ok: false, error: 'session_follow_source_forbidden' });

        expect(await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: owner.id,
            destinationSessionId: archived.id,
            sourceSessionId: source.id,
        })).toEqual({ ok: false, error: 'session_archived' });

        await grantAccess(destination, stranger.id, 'view');
        expect(await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: owner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        })).toEqual({ ok: false, error: 'session_follow_source_forbidden' });
        expect(await readEdge(destination.id, source.id)).toBeNull();
    });

    it('denies a destination whose derived runtime Account cannot read the source even when the author can read both', async () => {
        const sourceOwner = await createAccount();
        const destinationOwner = await createAccount();
        const source = await createSession(sourceOwner.id);
        const destination = await createSession(destinationOwner.id);
        // The configuring author can read the source and drive the destination,
        // but the destination's own runtime Account has no source access.
        await grantAccess(source, destinationOwner.id, 'view');
        await grantAccess(destination, sourceOwner.id, 'edit');
        await grantAccess(source, sourceOwner.id, 'view');

        expect(await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: sourceOwner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        })).toMatchObject({ ok: true });

        await db.sessionShare.deleteMany({ where: { sessionId: source.id, sharedWithUserId: destinationOwner.id } });
        await db.sessionFollowEdge.deleteMany();

        expect(await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: sourceOwner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        })).toEqual({ ok: false, error: 'session_follow_source_forbidden' });
    });

    it('rejects a broader destination audience even when the author and destination runtime can read the source', async () => {
        const owner = await createAccount();
        const reader = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        await grantAccess(destination, reader.id, 'view');

        expect(await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: owner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        })).toEqual({ ok: false, error: 'session_follow_source_forbidden' });
        expect(await readEdge(destination.id, source.id)).toBeNull();
    });

    it('rechecks a saved pair after audience broadening and permits safe contraction without reseeding it', async () => {
        const owner = await createAccount();
        const reader = await createAccount();
        const source = await createSession(owner.id, SEEDED_SOURCE);
        const destination = await createSession(owner.id);
        const input = {
            accountId: owner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        };
        expect(await setSessionFollowSource(input)).toMatchObject({ ok: true, value: { changed: true } });
        await db.session.update({ where: { id: source.id }, data: { seq: 20 } });
        await grantAccess(destination, reader.id, 'view');
        expect(await setSessionFollowSource(input)).toEqual({ ok: false, error: 'session_follow_source_forbidden' });
        expect(await readEdge(destination.id, source.id)).toMatchObject({ deliveredTranscriptSeq: 5 });

        await db.sessionShare.deleteMany({ where: { sessionId: destination.id, sharedWithUserId: reader.id } });
        expect(await setSessionFollowSource(input)).toMatchObject({ ok: true, value: { changed: false } });
        expect(await readEdge(destination.id, source.id)).toMatchObject({ deliveredTranscriptSeq: 5 });
    });

    it('checks destination readers beyond the first bounded audience page', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        const readers = Array.from({ length: 150 }, () => ({ id: `audience-${randomUUID()}`, publicKey: randomUUID(), encryptionMode: 'plain' as const }));
        const lastReader = { id: `zz-reader-${randomUUID()}`, publicKey: randomUUID(), encryptionMode: 'plain' as const };
        await db.account.createMany({ data: [...readers, lastReader] });
        await db.sessionShare.createMany({ data: [
            ...readers.flatMap(({ id }) => [source, destination].map((session) => ({
                sessionId: session.id, sharedByUserId: owner.id, sharedWithUserId: id, accessLevel: 'view' as const,
            }))),
            { sessionId: destination.id, sharedByUserId: owner.id, sharedWithUserId: lastReader.id, accessLevel: 'view' as const },
        ] });
        expect(await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: owner.id, destinationSessionId: destination.id, sourceSessionId: source.id,
        })).toEqual({ ok: false, error: 'session_follow_source_forbidden' });
        expect(await readEdge(destination.id, source.id)).toBeNull();
    });

    it('admits an editor with source read without access management or source-key readiness', async () => {
        const sourceOwner = await createAccount();
        await db.account.update({ where: { id: sourceOwner.id }, data: { encryptionMode: 'e2ee' } });
        const destinationOwner = await createAccount();
        const editor = await createAccount();
        const source = await createSession(sourceOwner.id, { encryptionMode: 'e2ee' });
        const destination = await createSession(destinationOwner.id);
        await grantAccess(source, destinationOwner.id, 'view');
        await grantAccess(source, editor.id, 'view');
        await grantAccess(destination, editor.id, 'edit');

        expect(await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: editor.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        })).toMatchObject({ ok: true, value: { changed: true } });
        expect(await db.sessionShare.count()).toBe(3);
    });

    it('rejects a Team destination reader whose membership horizon excludes the source grant', async () => {
        const owner = await createAccount();
        const member = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        const team = await db.team.create({ data: { name: randomUUID() } });
        const cutoff = new Date('2026-09-01T12:00:00.000Z');
        await db.teamMembership.create({ data: {
            teamId: team.id, accountId: member.id, role: 'member', sessionAccessStartsAt: cutoff,
        } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: source.id, teamId: team.id, effectiveAt: cutoff, accessLevel: 'view',
        } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: destination.id, teamId: team.id, effectiveAt: new Date(cutoff.getTime() + 1), accessLevel: 'view',
        } });
        const input = {
            accountId: owner.id, destinationSessionId: destination.id, sourceSessionId: source.id,
        };
        expect(await setSessionFollowSource(input)).toEqual({ ok: false, error: 'session_follow_source_forbidden' });
        expect(await readEdge(destination.id, source.id)).toBeNull();
        await grantAccess(source, member.id, 'view');
        expect(await setSessionFollowSource(input)).toMatchObject({ ok: true });
    });

    it('includes exact Group-granted guests and uses their Group horizon independently of the containing Team', async () => {
        const owner = await createAccount();
        const guest = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        const team = await db.team.create({ data: { name: randomUUID() } });
        const cutoff = new Date('2026-09-01T12:00:00.000Z');
        const membership = await db.teamMembership.create({ data: {
            teamId: team.id, accountId: guest.id, role: 'guest', sessionAccessStartsAt: cutoff,
        } });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Guests', nameKey: 'guests' } });
        await db.teamGroupMembership.create({ data: {
            teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id,
            nativeContribution: true, sessionAccessStartsAt: null,
        } });
        await db.sessionTeamGrant.create({ data: {
            sessionId: source.id, teamId: team.id, effectiveAt: new Date(cutoff.getTime() + 1), accessLevel: 'view',
        } });
        await db.sessionGroupGrant.create({ data: {
            sessionId: destination.id, teamGroupId: group.id, effectiveAt: cutoff, accessLevel: 'view',
        } });
        const input = {
            accountId: owner.id, destinationSessionId: destination.id, sourceSessionId: source.id,
        };
        expect(await setSessionFollowSource(input)).toEqual({ ok: false, error: 'session_follow_source_forbidden' });
        await db.sessionGroupGrant.create({ data: {
            sessionId: source.id, teamGroupId: group.id,
            effectiveAt: new Date(cutoff.getTime() - 1), accessLevel: 'view',
        } });
        expect(await setSessionFollowSource(input)).toMatchObject({ ok: true });
    });

    it('is idempotent for repeated set and for removing an absent edge, and never grants source read on removal', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, SEEDED_SOURCE);
        const destination = await createSession(owner.id);
        const args = {
            accountId: owner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        };

        const accountSeqBeforeCreate = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
        expect(await setSessionFollowSource(args)).toMatchObject({ ok: true, value: { changed: true } });
        expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: owner.id, kind: 'session', entityId: destination.id,
        } } })).toMatchObject({ cursor: accountSeqBeforeCreate + 1 });
        await db.session.update({ where: { id: source.id }, data: { seq: 42 } });
        expect(await setSessionFollowSource(args)).toMatchObject({ ok: true, value: { changed: false } });
        expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(accountSeqBeforeCreate + 2);
        // A repeated set must not reseed: the pending delta stays deliverable.
        expect(await readEdge(destination.id, source.id)).toMatchObject({ deliveredTranscriptSeq: 5 });

        const removeArgs = {
            accountId: owner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        };
        expect(await removeSessionFollowSource(removeArgs)).toEqual({ ok: true, value: { changed: true } });
        expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(accountSeqBeforeCreate + 4);
        expect(await removeSessionFollowSource(removeArgs)).toEqual({ ok: true, value: { changed: false } });
        expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(accountSeqBeforeCreate + 4);
    });

    it('invalidates the exact destination Session once for an actual policy change', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        const args = {
            accountId: owner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        };

        expect(await setSessionFollowSource(args)).toMatchObject({ ok: true, value: { changed: true } });
        const seqAfterCreate = (await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq;
        expect(await setSessionFollowSource({ ...args, policy: { preset: 'custom' as const, events: { person_wrote: { delivery: 'interrupt' as const }, message: { delivery: 'quiet' as const } } } })).toMatchObject({
            ok: true,
            value: { changed: true, source: { policy: { preset: 'custom' as const, events: { person_wrote: { delivery: 'interrupt' as const }, message: { delivery: 'quiet' as const } } } } },
        });
        expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(seqAfterCreate + 2);
        expect(await db.accountChange.findUnique({ where: { accountId_kind_entityId: {
            accountId: owner.id, kind: 'session', entityId: destination.id,
        } } })).toMatchObject({ cursor: seqAfterCreate + 1 });

        expect(await setSessionFollowSource({ ...args, policy: { preset: 'custom' as const, events: { person_wrote: { delivery: 'interrupt' as const }, message: { delivery: 'quiet' as const } } } })).toMatchObject({
            ok: true,
            value: { changed: false },
        });
        expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(seqAfterCreate + 2);
    });

    it('converges concurrent first writers on one seeded edge', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, SEEDED_SOURCE);
        const destination = await createSession(owner.id);
        const args = {
            accountId: owner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        };

        const results = await Promise.all([
            setSessionFollowSource(args),
            setSessionFollowSource(args),
        ]);

        expect(results.every((result) => result.ok)).toBe(true);
        expect(results.filter((result) => result.ok && result.value.changed)).toHaveLength(1);
        expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).seq).toBe(2);
        expect(await db.sessionFollowEdge.count({ where: {
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        } })).toBe(1);
        expect(await readEdge(destination.id, source.id)).toMatchObject({
            deliveredTranscriptSeq: SEEDED_SOURCE.seq,
            deliveredReadyEventSeq: SEEDED_SOURCE.latestReadyEventSeq,
            deliveredAgentStateVersion: SEEDED_SOURCE.agentStateVersion,
            deliveredTurnId: SEEDED_SOURCE.latestTurnId,
            deliveredTurnStatus: SEEDED_SOURCE.latestTurnStatus,
        });
    });

    it('rejects mutations from a suspended Account after authentication', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        await db.account.update({ where: { id: owner.id }, data: { status: 'suspended' } });

        expect(await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: owner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        })).toEqual({ ok: false, error: 'account_inactive' });
        expect(await listSessionFollowSources({ accountId: owner.id, destinationSessionId: destination.id }))
            .toEqual({ ok: false, error: 'account_inactive' });
    });

    it('lists only sources the caller can still read and marks archived pairs paused', async () => {
        const owner = await createAccount();
        const collaborator = await createAccount();
        const readable = await createSession(owner.id);
        const secret = await createSession(owner.id);
        const destination = await createSession(owner.id);
        await grantAccess(destination, collaborator.id, 'edit');
        await grantAccess(readable, collaborator.id, 'view');
        await grantAccess(secret, collaborator.id, 'view');
        for (const source of [readable, secret]) {
            await setSessionFollowSource({ policy: { preset: 'everything' as const },
                accountId: owner.id,
                destinationSessionId: destination.id,
                sourceSessionId: source.id,
            });
        }

        await db.sessionShare.deleteMany({ where: { sessionId: secret.id, sharedWithUserId: collaborator.id } });

        const collaboratorView = await listSessionFollowSources({
            accountId: collaborator.id,
            destinationSessionId: destination.id,
        });
        expect(collaboratorView).toMatchObject({ ok: true });
        expect(collaboratorView.ok && collaboratorView.value.sources.flatMap(entry => 'sourceSessionId' in entry ? [entry.sourceSessionId] : [])).toEqual([readable.id]);

        await db.session.update({ where: { id: readable.id }, data: { seq: { increment: 1 } } });
        const pendingView = await listSessionFollowSources({
            accountId: collaborator.id,
            destinationSessionId: destination.id,
        });
        expect(pendingView.ok && pendingView.value.sources[0]?.hasPendingUpdates).toBe(true);

        await db.session.update({ where: { id: readable.id }, data: { archivedAt: new Date() } });
        const archivedView = await listSessionFollowSources({
            accountId: collaborator.id,
            destinationSessionId: destination.id,
        });
        expect(archivedView.ok && archivedView.value.sources[0]?.deliveryState).toBe('paused_archived');
        expect(archivedView.ok && archivedView.value.sources[0]?.hasPendingUpdates).toBe(true);
    });

    it('observes an exact terminal-turn change but ignores a timestamp-only change, and stays silent while archived', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, SEEDED_SOURCE);
        const destination = await createSession(owner.id);
        await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: owner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        });

        await db.session.update({ where: { id: source.id }, data: { latestTurnStatusObservedAt: BigInt(Date.now()) } });
        expect(await inTx((tx: Tx) => observePendingSessionFollowForDestinationInTx(tx, {
            destinationSessionId: destination.id,
            principal: runtimePrincipal(owner.id),
        }))).toEqual([]);

        await db.session.update({ where: { id: source.id }, data: { latestTurnId: 'turn-b' } });
        const pending = await inTx((tx: Tx) => observePendingSessionFollowForDestinationInTx(tx, {
            destinationSessionId: destination.id,
            principal: runtimePrincipal(owner.id),
        }));
        expect(pending).toHaveLength(1);
        expect(pending[0]?.observed.turn).toEqual({ id: 'turn-b', status: 'completed' });
        expect(pending[0]?.delivered.turn).toEqual({ id: 'turn-a', status: 'completed' });

        await db.session.update({ where: { id: source.id }, data: { archivedAt: new Date() } });
        expect(await inTx((tx: Tx) => observePendingSessionFollowForDestinationInTx(tx, {
            destinationSessionId: destination.id,
            principal: runtimePrincipal(owner.id),
        }))).toEqual([]);
    });

    it('advances the frontier only through an exact compare-and-set and refuses stale, duplicated or over-reaching acknowledgments', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, SEEDED_SOURCE);
        const destination = await createSession(owner.id);
        await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: owner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        });
        await db.session.update({
            where: { id: source.id },
            data: { seq: 9, latestReadyEventSeq: 4, latestTurnId: 'turn-b', latestTurnStatus: 'failed' },
        });

        const expected = { transcriptSeq: 5, readyEventSeq: 3, agentStateVersion: 2, turn: { id: 'turn-a', status: 'completed' as const } };
        const consumed = { transcriptSeq: 9, readyEventSeq: 4, agentStateVersion: 2, turn: { id: 'turn-b', status: 'failed' as const } };
        const generation = await loadPublisherGeneration(destination.id);
        await db.sessionMessage.create({ data: {
            sessionId: destination.id,
            seq: 1,
            localId: 'accepted-follow-input',
            messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'continue' } } },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: owner.id, sessionRelationship: 'owner' },
        } });
        const base = { policy: { preset: 'everything' as const },
            principal: runtimePrincipal(owner.id),
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
            expectedPublisherGeneration: generation,
            observed: consumed,
            acceptance: { kind: 'admitted_input', localInputId: 'accepted-follow-input', userMessageSeq: 1 } as const,
        };

        expect(await inTx((tx: Tx) => acknowledgeSessionFollowFrontierInTx(tx, {
            ...base,
            expected,
            observed: { ...consumed, transcriptSeq: 8 },
            consumed,
        }))).toEqual({ ok: false, rejection: 'invalid_consumed_frontier' });

        expect(await inTx((tx: Tx) => acknowledgeSessionFollowFrontierInTx(tx, {
            ...base,
            expected,
            consumed: { ...consumed, transcriptSeq: 40 },
        }))).toEqual({ ok: false, rejection: 'invalid_consumed_frontier' });

        expect(await inTx((tx: Tx) => acknowledgeSessionFollowFrontierInTx(tx, {
            ...base,
            expected,
            observed: { ...consumed, turn: { id: 'turn-a', status: 'completed' } },
            consumed: { ...consumed, turn: { id: 'turn-a', status: 'completed' } },
        }))).toEqual({ ok: false, rejection: 'stale_terminal_turn' });
        // A rejected terminal turn must not partially advance the numeric components.
        expect(await readEdge(destination.id, source.id)).toMatchObject({ deliveredTranscriptSeq: 5 });

        expect(await inTx((tx: Tx) => acknowledgeSessionFollowFrontierInTx(tx, {
            ...base,
            expectedPublisherGeneration: generation + 1n,
            expected,
            consumed,
        }))).toEqual({ ok: false, rejection: 'stale_publisher_generation' });

        expect(await inTx((tx: Tx) => acknowledgeSessionFollowFrontierInTx(tx, { ...base, expected, consumed })))
            .toEqual({ ok: true, delivered: consumed });
        expect(await readEdge(destination.id, source.id)).toMatchObject({
            deliveredTranscriptSeq: 9,
            deliveredReadyEventSeq: 4,
            deliveredAgentStateVersion: 2,
            deliveredTurnId: 'turn-b',
            deliveredTurnStatus: 'failed',
        });

        // The replayed acknowledgment carries a now-stale expected tuple and
        // cannot regress the row.
        expect(await inTx((tx: Tx) => acknowledgeSessionFollowFrontierInTx(tx, { ...base, expected, consumed })))
            .toEqual({ ok: false, rejection: 'stale_expected_frontier' });
        expect(await readEdge(destination.id, source.id)).toMatchObject({ deliveredTranscriptSeq: 9 });
    });

    it('ACKs a represented source prefix while retaining a pending current terminal turn', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, SEEDED_SOURCE);
        const destination = await createSession(owner.id);
        await setSessionFollowSource({ policy: { preset: 'everything' as const }, accountId: owner.id, sourceSessionId: source.id, destinationSessionId: destination.id });
        await db.session.update({ where: { id: source.id }, data: {
            seq: 9, latestReadyEventSeq: 4, latestTurnId: 'turn-b', latestTurnStatus: 'failed',
        } });
        const [observation] = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: runtimePrincipal(owner.id), destinationSessionId: destination.id,
        }));
        if (!observation || !('relation' in observation)) throw new Error('Expected pending original source progress');
        await db.sessionMessage.createMany({ data: [1, 2].map(seq => ({
            sessionId: destination.id, seq, localId: `accepted-prefix-${seq}`, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: `Source prefix ${seq}` } } },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: owner.id, sessionRelationship: 'owner' },
        })) });
        const consumed = { ...observation.delivered, transcriptSeq: 7 };
        const base = { policy: observation.policy,
            principal: runtimePrincipal(owner.id), destinationSessionId: destination.id, sourceSessionId: source.id,
            expectedPublisherGeneration: destination.publisherGeneration,
            acceptance: { kind: 'admitted_input', localInputId: 'accepted-prefix-1', userMessageSeq: 1 } as const,
        };
        expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, {
            ...base, expected: observation.delivered, observed: observation.observed, consumed,
        }))).toEqual({ ok: true, delivered: consumed });
        expect(await readEdge(destination.id, source.id)).toMatchObject({
            deliveredTranscriptSeq: 7, deliveredTurnId: 'turn-a', deliveredTurnStatus: 'completed',
        });
        const pending = await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: runtimePrincipal(owner.id), destinationSessionId: destination.id,
        }));
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ delivered: consumed, observed: observation.observed });
        await db.session.update({ where: { id: source.id }, data: { latestTurnId: 'turn-c' } });
        expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, {
            ...base, expected: consumed, observed: observation.observed, consumed: { ...consumed, transcriptSeq: 8 },
        }))).toEqual({ ok: false, rejection: 'stale_terminal_turn' });
        expect(await readEdge(destination.id, source.id)).toMatchObject({ deliveredTranscriptSeq: 7 });
        await db.session.update({ where: { id: source.id }, data: { latestTurnId: 'turn-b' } });
        expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, {
            ...base, acceptance: { kind: 'admitted_input', localInputId: 'accepted-prefix-2', userMessageSeq: 2 },
            expected: consumed, observed: observation.observed, consumed: observation.observed,
        }))).toEqual({ ok: true, delivered: observation.observed });
        expect(await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: runtimePrincipal(owner.id), destinationSessionId: destination.id,
        }))).toEqual([]);
    });

    it.each(['current', 'reattached', 'detached', 'absent_from_batch', 'uncovered_prefix'] as const)(
        'settles ordinary next-turn coverage only through the same accepted manager attachment: %s', async managerState => {
        const owner = await createAccount();
        const source = await createSession(owner.id);
        const destination = await createSession(owner.id);
        await setSessionFollowSource({ policy: { preset: 'quiet' as const }, accountId: owner.id, sourceSessionId: source.id, destinationSessionId: destination.id });
        expect((await setSessionManager({ accountId: owner.id, sessionId: source.id, managerSessionId: destination.id,
            expectedManagerSessionId: null, authentication })).ok).toBe(true);
        await db.session.update({ where: { id: source.id }, data: { seq: 1 } });
        const pending = (await inTx(tx => observePendingSessionFollowForDestinationInTx(tx, {
            principal: runtimePrincipal(owner.id), destinationSessionId: destination.id, includeManager: true,
        }))).map(observation => {
            if (!('relation' in observation) || observation.relation === 'rule') throw new Error('Expected independently stored Session Follow routes');
            return observation;
        });
        const follower = pending.find(row => row.relation === 'follower');
        const manager = pending.find(row => row.relation === 'manager');
        if (!follower || !manager) throw new Error('Expected independently stored overlapping routes');
        const observations = pending.filter(row => managerState !== 'absent_from_batch' || row.relation !== 'manager')
            .map(row => ({ policy: row.policy, sourceSessionId: row.sourceSessionId, relation: row.relation,
                ...(row.relation === 'manager' ? { attachedAt: row.attachedAt } : {}),
                expected: row.delivered, consumed: managerState === 'uncovered_prefix' && row.relation === 'manager'
                    ? row.delivered : row.observed }));
        const eventLocalId = deriveSessionFollowWakeEventLocalIdV1({ destinationSessionId: destination.id,
            publisherGeneration: destination.publisherGeneration.toString(), observations });
        await db.sessionMessage.create({ data: { sessionId: destination.id, seq: 1, localId: eventLocalId,
            messageRole: 'event', content: { t: 'plain', v: { role: 'agent', content: { type: 'event',
                data: TranscriptRawAgentEventV1Schema.parse({ type: 'message', message: SESSION_FOLLOW_WAKE_EVENT_MESSAGE }) } } },
            transcriptObservationProvenance: { kind: 'non_dependent', source: 'external' },
        } });
        const base = { policy: follower.policy, principal: runtimePrincipal(owner.id), destinationSessionId: destination.id, sourceSessionId: source.id,
            expectedPublisherGeneration: destination.publisherGeneration,
            acceptance: { kind: 'context_only_wake', eventLocalId, observations } as const };
        if (managerState === 'current') {
            // The manager can settle first: its stored frontier is no longer
            // the batch's expected tuple when the covered follower ACK arrives.
            expect(await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, { ...base, relation: 'manager',
                policy: manager.policy,
                attachedAt: manager.attachedAt, expected: manager.delivered, observed: manager.observed, consumed: manager.observed })))
                .toEqual({ ok: true, delivered: manager.observed });
        } else if (managerState === 'reattached' || managerState === 'detached') {
            await setSessionManager({ accountId: owner.id, sessionId: source.id, managerSessionId: null,
                expectedManagerSessionId: destination.id, authentication });
            if (managerState === 'reattached') {
                await setSessionManager({ accountId: owner.id, sessionId: source.id, managerSessionId: destination.id,
                    expectedManagerSessionId: null, authentication });
            }
        }
        const result = await inTx(tx => acknowledgeSessionFollowFrontierInTx(tx, { ...base, relation: 'follower',
            expected: follower.delivered, observed: follower.observed, consumed: follower.observed }));
        expect(result).toEqual(managerState === 'current' ? { ok: true, delivered: follower.observed }
            : { ok: false, rejection: 'provider_acceptance_unverified' });
        expect(await readEdge(destination.id, source.id)).toMatchObject({ deliveredTranscriptSeq: managerState === 'current' ? 1 : 0 });
    });

    it('performs no acknowledgment while either endpoint is archived and reseeds only when both are restored', async () => {
        const owner = await createAccount();
        const source = await createSession(owner.id, SEEDED_SOURCE);
        const destination = await createSession(owner.id);
        await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: owner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        });

        for (const sessionId of [destination.id, source.id]) {
            await inTx((tx) => transitionSessionArchiveStateInTx({ tx, sessionId, wasArchived: false, archivedAt: new Date() }));
        }
        await db.session.update({ where: { id: source.id }, data: {
            seq: 30, latestReadyEventSeq: 8, agentStateVersion: 9,
            latestTurnId: 'turn-z', latestTurnStatus: 'cancelled',
        } });

        const archivedGeneration = await loadPublisherGeneration(destination.id);
        expect(await inTx((tx: Tx) => acknowledgeSessionFollowFrontierInTx(tx, { policy: { preset: 'everything' as const },
            principal: runtimePrincipal(owner.id),
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
            expectedPublisherGeneration: archivedGeneration,
            expected: { transcriptSeq: 5, readyEventSeq: 3, agentStateVersion: 2, turn: { id: 'turn-a', status: 'completed' } },
            observed: { transcriptSeq: 30, readyEventSeq: 3, agentStateVersion: 2, turn: { id: 'turn-z', status: 'cancelled' } },
            consumed: { transcriptSeq: 30, readyEventSeq: 3, agentStateVersion: 2, turn: { id: 'turn-z', status: 'cancelled' } },
            acceptance: { kind: 'admitted_input', localInputId: 'irrelevant-while-archived', userMessageSeq: null },
        }))).toEqual({ ok: false, rejection: 'session_archived' });

        // Restoring one endpoint leaves the pair dormant and unseeded.
        await inTx((tx) => transitionSessionArchiveStateInTx({ tx, sessionId: source.id, wasArchived: true, archivedAt: null }));
        expect(await readEdge(destination.id, source.id)).toMatchObject({ deliveredTranscriptSeq: 5 });
        expect(await inTx((tx) => observePendingSessionFollowForDestinationInTx(tx, {
            destinationSessionId: destination.id,
            principal: runtimePrincipal(owner.id),
        }))).toEqual([]);

        await inTx((tx) => transitionSessionArchiveStateInTx({ tx, sessionId: destination.id, wasArchived: true, archivedAt: null }));
        expect(await readEdge(destination.id, source.id)).toMatchObject({
            deliveredTranscriptSeq: 30,
            deliveredReadyEventSeq: 8,
            deliveredAgentStateVersion: 9,
            deliveredTurnId: 'turn-z',
            deliveredTurnStatus: 'cancelled',
        });
        expect(await inTx((tx: Tx) => observePendingSessionFollowForDestinationInTx(tx, {
            destinationSessionId: destination.id,
            principal: runtimePrincipal(owner.id),
        }))).toEqual([]);
        await db.session.update({ where: { id: source.id }, data: { seq: 31 } });
        expect(await inTx((tx) => observePendingSessionFollowForDestinationInTx(tx, {
            destinationSessionId: destination.id,
            principal: runtimePrincipal(owner.id),
        }))).toMatchObject([{ delivered: { transcriptSeq: 30 }, observed: { transcriptSeq: 31 } }]);
    });

    it('admits runtime observation and ACK only for the verified destination runtime principal', async () => {
        const owner = await createAccount();
        const outsider = await createAccount();
        const source = await createSession(owner.id, SEEDED_SOURCE);
        const destination = await createSession(owner.id);
        await setSessionFollowSource({ policy: { preset: 'everything' as const },
            accountId: owner.id,
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
        });

        // A principal that is not the destination runtime observes nothing and
        // cannot acknowledge, even though the edge and frontiers are valid.
        expect(await inTx((tx: Tx) => observePendingSessionFollowForDestinationInTx(tx, {
            principal: runtimePrincipal(outsider.id),
            destinationSessionId: destination.id,
        }))).toEqual([]);
        await db.session.update({ where: { id: source.id }, data: { seq: 6 } });
        const pending = await inTx((tx: Tx) => observePendingSessionFollowForDestinationInTx(tx, {
            principal: runtimePrincipal(owner.id),
            destinationSessionId: destination.id,
        }));
        expect(pending).toHaveLength(1);
        const generation = await loadPublisherGeneration(destination.id);
        expect(await inTx((tx: Tx) => acknowledgeSessionFollowFrontierInTx(tx, { policy: { preset: 'everything' as const },
            principal: runtimePrincipal(outsider.id),
            destinationSessionId: destination.id,
            sourceSessionId: source.id,
            expectedPublisherGeneration: generation,
            expected: pending[0]!.delivered,
            observed: pending[0]!.observed,
            consumed: pending[0]!.observed,
            acceptance: { kind: 'admitted_input', localInputId: 'irrelevant-for-wrong-principal', userMessageSeq: null },
        }))).toEqual({ ok: false, rejection: 'source_forbidden' });
        expect(await readEdge(destination.id, source.id)).toMatchObject({ deliveredTranscriptSeq: 5 });
    });

    it('removes only the edges whose destination runtime Account actually lost source access, and cascades on Session deletion', async () => {
        const sourceOwner = await createAccount();
        const keeper = await createAccount();
        const loser = await createAccount();
        const source = await createSession(sourceOwner.id);
        const keptDestination = await createSession(keeper.id);
        const lostDestination = await createSession(loser.id);
        await grantAccess(source, keeper.id, 'view');
        await grantAccess(source, loser.id, 'view');
        await grantAccess(keptDestination, sourceOwner.id, 'edit');
        await grantAccess(lostDestination, sourceOwner.id, 'edit');
        await grantAccess(source, sourceOwner.id, 'view');

        for (const destination of [keptDestination, lostDestination]) {
            expect(await setSessionFollowSource({ policy: { preset: 'everything' as const },
                accountId: sourceOwner.id,
                destinationSessionId: destination.id,
                sourceSessionId: source.id,
            })).toMatchObject({ ok: true });
        }

        await db.sessionShare.deleteMany({ where: { sessionId: source.id, sharedWithUserId: loser.id } });
        expect(await inTx((tx: Tx) => removeUnsafeSessionFollowEdgesForAccessChangeInTx(tx, {
            sessionId: source.id,
        }))).toBe(1);
        expect(await readEdge(lostDestination.id, source.id)).toBeNull();
        expect(await readEdge(keptDestination.id, source.id)).not.toBeNull();

        await db.session.delete({ where: { id: source.id } });
        expect(await db.sessionFollowEdge.count()).toBe(0);
    });
});
