import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { resolveSessionFollowFactsInTx } from '@/app/session/personal/followFacts';
import { createSessionListScopeWhere } from '@/app/session/personal/queries';
import {
    setSessionAutoFollowPreferences,
    setOtherAccountFollow,
    removeOtherAccountFollow,
    getOtherAccountFollow,
    listAccountSessionFollows,
    readOtherPersonalFollowerCensusInTx,
    readAccountRunFollowDeliveryInTx,
    getAccountSessionFollow as getAccountSessionFollowWithAuthentication,
    removeAccountSessionFollow as removeAccountSessionFollowWithAuthentication,
    setAccountSessionFollow as setAccountSessionFollowWithAuthentication,
    replaceAccountSessionVoiceInclusions as replaceAccountSessionVoiceInclusionsWithAuthentication,
    observePendingAccountVoiceFollowInTx,
    acknowledgeAccountVoiceFollowInTx,
    consumeAccountSessionFollowOnceInTx,
    acceptAccountSessionFollowOnceDelivery,
    removeAccountSessionFollowsOnAccessLossInTx,
} from './accountFollowService';
import { VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG, ARTIFACT_PLAIN_DATA_KEY_MARKER, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { encodePlainMachineStoredContent } from '@happier-dev/protocol/machines/machineStoredContent';
import { acceptAccountFollowPersonalProgress } from './accountFollowPersonalProgress';
import type { ExecutionRunFollowFrontierWitness } from './executionRunFollowSource';
import { resolveExecutionRunFollowOccurrenceV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowInputV1';
import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } from '@happier-dev/protocol/sessions/follow/changes';
import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { transitionSessionArchiveStateInTx } from '@/app/session/archive/transitionSessionArchiveStateInTx';
import { changeDeliveryMute } from './sessionDeliveryMuteService';
import { normalizeAccountFollowNotificationChoiceV1, PersistedPersonalRunFollowOnceV1Schema } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { getAccountFollowRule, setAccountFollowRule } from './accountFollowRuleService';
import { readSessionFollowRuleProgressInTx, writeSessionFollowRuleProgressInTx } from './sessionFollowRuleProgress';

// The push provider is the external boundary; Follow, transactions, badge
// candidacy, counting and coalescing execute through their real owners.
const sendPushNotificationsAsync = vi.hoisted(() => vi.fn(async (messages: unknown[]) => messages.map(() => ({ status: 'ok' }))));
vi.mock('expo-server-sdk', () => {
    class Expo {
        static isExpoPushToken() { return true; }
        chunkPushNotifications(messages: unknown[]) { return [messages]; }
        async sendPushNotificationsAsync(messages: unknown[]) { return sendPushNotificationsAsync(messages); }
        async getPushNotificationReceiptsAsync() { return {}; }
    }
    return { Expo };
});

const defaultAuthentication = {
    env: process.env,
    authority: 'present_user' as const,
    authenticationEvidence: undefined,
};

type GetAccountSessionFollowParams = Parameters<typeof getAccountSessionFollowWithAuthentication>[0];
function getAccountSessionFollow(params: Omit<GetAccountSessionFollowParams, 'authentication'>) {
    return getAccountSessionFollowWithAuthentication({ ...params, authentication: defaultAuthentication });
}

type RemoveAccountSessionFollowParams = Parameters<typeof removeAccountSessionFollowWithAuthentication>[0];
function removeAccountSessionFollow(params: Omit<RemoveAccountSessionFollowParams, 'authentication'>) {
    return removeAccountSessionFollowWithAuthentication({ ...params, authentication: defaultAuthentication });
}

type SetAccountSessionFollowParams = Parameters<typeof setAccountSessionFollowWithAuthentication>[0];
function setAccountSessionFollow(params: Omit<SetAccountSessionFollowParams, 'authentication'>) {
    return setAccountSessionFollowWithAuthentication({ ...params, authentication: defaultAuthentication });
}
function replaceAccountSessionVoiceInclusions(params: Omit<Parameters<typeof replaceAccountSessionVoiceInclusionsWithAuthentication>[0], 'authentication'>) {
    return replaceAccountSessionVoiceInclusionsWithAuthentication({ ...params, authentication: defaultAuthentication });
}

async function fixture() {
    const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const viewer = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', seq: 10 } });
    await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id, accountId: viewer.id, accessLevel: 'view' } });
    return { owner, viewer, session, key: { accountId: viewer.id, sessionId: session.id } };
}

async function createDiscussion(params: Readonly<{
    sessionId: string;
    creatorAccountId: string;
    messageSeq: number;
    archivedAt?: Date;
}>) {
    return await db.discussion.create({
        data: {
            ownerAccountId: params.creatorAccountId,
            encryptionMode: "plain",
            dataEncryptionKey: Uint8Array.from(decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER)),
            anchorV1: { kind: "session", sessionId: params.sessionId },
            anchorSessionId: params.sessionId,
            creationLocalId: randomUUID(),
            creationEqualityEvidenceV1: { kind: 'plainDigest', digest: randomUUID() },
            createdByAccountId: params.creatorAccountId,
            titleContent: { t: 'plain', v: { v: 1, title: 'Tracking baseline' } },
            messageSeq: params.messageSeq,
            lastMessageAt: new Date(),
            archivedAt: params.archivedAt,
        },
    });
}
describe('Account Follow service', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-follow-service-', initEncrypt: true,
        env: {
            HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED: 'true',
            HAPPIER_FEATURE_SHARING_SESSION__ENABLED: 'true',
            HAPPIER_SERVER_IDENTITY_ID: 'srv_follow_once',
        },
    }); }, 180_000);
    afterEach(async () => {
        await db.accountPushToken.deleteMany();
        await db.accountSessionReadState.deleteMany();
        await db.accountSessionFollow.deleteMany();
        await db.sessionGrant.deleteMany({ where: { principalKind: 'account' } });
        await db.sessionMessage.deleteMany();
        await db.accessKey.deleteMany();
        await db.session.deleteMany();
        await db.machine.deleteMany();
        await db.account.deleteMany();
    });
    afterAll(async () => { await harness?.close(); });

    it.each(['completed', 'failed'] as const)('accepts the exact private-rule %s Turn from its terminal receipt and preserves the numeric prefix', async status => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: Uint8Array.from(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)), active: true } });
        const sourceId = randomUUID();
        const source = await db.session.create({ data: { id: sourceId, accountId: account.id, tag: randomUUID(), encryptionMode: 'plain',
            metadata: '{}', seq: 9, agentStateVersion: 5, publisherGeneration: 1n,
            runtimeMachineTarget: { homeId: 'srv_follow_once', accountId: account.id, sessionId: sourceId,
                machineId: machine.id, installationId: machine.installationId! } } });
        await db.accessKey.create({ data: { accountId: account.id, sessionId: source.id,
            machineId: machine.id, data: MACHINE_PLAIN_DATA_KEY_MARKER } });
        const scope = { accountId: account.id, authentication: defaultAuthentication, ruleId: randomUUID() };
        const created = await setAccountFollowRule({ ...scope, mutation: { receiver: { kind: 'account' }, expectedVersion: -1,
            content: { t: 'plain', v: { v: 1, enabled: true, filter: normalizeSessionListFilterV1({ homeServerIds: ['srv_follow_once'] }), policy: { preset: 'important' } } },
        } });
        expect(created.ok).toBe(true);
        if (!created.ok) throw new Error(created.error);
        const rule = { ruleId: scope.ruleId, ruleVersion: created.value.rule.version };
        await inTx(async tx => {
            const progress = await readSessionFollowRuleProgressInTx(tx, { accountId: account.id, sourceSessionId: source.id, rule });
            expect(progress).not.toBeNull();
            expect(await writeSessionFollowRuleProgressInTx(tx, progress!, {
                transcriptSeq: 7, readyEventSeq: 0, agentStateVersion: 2, turn: null,
            })).toBe(true);
        });
        const terminalAt = BigInt(Date.now());
        await db.sessionTurn.create({ data: { sessionId: source.id, turnId: 'silent-terminal', status,
            startedAt: terminalAt - 1n, updatedAt: terminalAt, terminalAt } });
        const terminalSourceMessage = { localId: randomUUID(), seq: 9 };
        await db.sessionMessage.create({ data: { sessionId: source.id, ...terminalSourceMessage, messageRole: 'event',
            content: { t: 'plain', v: { role: 'agent', meta: { source: 'runtime', runtimeTurnId: 'silent-terminal' },
                content: status === 'completed' ? { type: 'event', id: terminalSourceMessage.localId,
                    data: { type: 'ready', completedTurnId: 'silent-terminal' } }
                    : { type: 'codex', data: { type: 'turn_failed', id: 'native-provider-turn' } } } } } });
        await db.session.update({ where: { id: source.id }, data: { active: false,
            latestTurnId: 'silent-terminal', latestTurnStatus: status, latestReadyEventSeq: status === 'completed' ? 9 : null } });
        const occurrence = { sourceSessionId: source.id, expectedSourcePublisherGeneration: '1', machineId: machine.id,
            installationId: machine.installationId!, rules: [rule], sourceTurn: { id: 'silent-terminal', status }, terminalSourceMessage };
        const accept = (value = occurrence) => acceptAccountFollowPersonalProgress({ ...scope, occurrence: value });
        const missingProof: Record<string, unknown> = { ...occurrence };
        delete missingProof.terminalSourceMessage;
        expect(await acceptAccountFollowPersonalProgress({ ...scope,
            // @ts-expect-error Raw external request intentionally omits mandatory terminal proof.
            occurrence: missingProof,
        })).toEqual({ ok: false, error: 'invalid_parameters' });
        expect(await accept({ ...occurrence, terminalSourceMessage: { ...terminalSourceMessage, seq: 8 } }))
            .toMatchObject({ ok: true, value: { accepted: false } });
        expect(await accept({ ...occurrence, sourceTurn: { ...occurrence.sourceTurn,
            status: status === 'completed' ? 'failed' : 'completed' } })).toMatchObject({ ok: true, value: { accepted: false } });
        const transaction = db.$transaction;
        let inventories = 0;
        const tracedTransaction = async (work: (tx: Tx) => Promise<unknown>, options?: Parameters<typeof db.$transaction>[1]) => transaction(async tx => {
            // Count reads at the real persistent boundary; all query results and domain logic stay real.
            const messages = vi.spyOn(tx.sessionMessage, 'findMany');
            const pending = vi.spyOn(tx.sessionPendingMessage, 'findMany');
            try { return await work(tx); }
            finally { inventories += messages.mock.calls.length + pending.mock.calls.length;
                messages.mockRestore(); pending.mockRestore(); }
        }, options);
        db.$transaction = tracedTransaction as typeof db.$transaction;
        try {
            expect(await accept()).toEqual({ ok: true, value: { accepted: true, alreadyRepresented: false } });
            expect(inventories).toBe(0);
        } finally { db.$transaction = transaction; }
        expect(await accept()).toEqual({ ok: true, value: { accepted: true, alreadyRepresented: true } });
        expect(await getAccountFollowRule(scope)).toMatchObject({ ok: true, value: { rule: { sources: [{
            sourceSessionId: source.id, delivered: { transcriptSeq: 7, readyEventSeq: 9, agentStateVersion: 2,
                turn: occurrence.sourceTurn },
        }] } } });
        expect(await db.sessionMessage.count({ where: { sessionId: source.id } })).toBe(1);
        expect((await db.session.findUniqueOrThrow({ where: { id: source.id } })).latestReadyEventSeq).toBe(status === 'completed' ? 9 : null);
        expect(await accept({ ...occurrence, rules: [] })).toMatchObject({ ok: true, value: { accepted: false } });
        const nextTurn = { id: 'later-silent-terminal', status };
        await db.sessionTurn.create({ data: { sessionId: source.id, turnId: nextTurn.id, status,
            startedAt: terminalAt - 1n, updatedAt: terminalAt, terminalAt } });
        const nextTerminalSourceMessage = { localId: randomUUID(), seq: 10 };
        await db.sessionMessage.create({ data: { sessionId: source.id, ...nextTerminalSourceMessage, messageRole: 'event',
            content: { t: 'plain', v: { role: 'agent', meta: { source: 'runtime', runtimeTurnId: nextTurn.id },
                content: status === 'completed' ? { type: 'event', id: nextTerminalSourceMessage.localId,
                    data: { type: 'ready', completedTurnId: nextTurn.id } }
                    : { type: 'codex', data: { type: 'turn_failed', id: 'later-native-provider-turn' } } } } } });
        await db.session.update({ where: { id: source.id }, data: { seq: 10, latestTurnId: nextTurn.id, latestTurnStatus: status,
            latestReadyEventSeq: status === 'completed' ? 10 : null } });
        expect(await accept({ ...occurrence, sourceTurn: nextTurn, terminalSourceMessage: nextTerminalSourceMessage }))
            .toEqual({ ok: true, value: { accepted: true, alreadyRepresented: false } });
        expect(await accept()).toEqual({ ok: true, value: { accepted: true, alreadyRepresented: true } });
        expect(await getAccountFollowRule(scope)).toMatchObject({ ok: true, value: { rule: { sources: [{
            sourceSessionId: source.id, delivered: { transcriptSeq: 7, readyEventSeq: 10, agentStateVersion: 2, turn: nextTurn },
        }] } } });
    });

    it('arms an exact detached Machine Run, accepts its one-shot once and keeps it private', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: Uint8Array.from(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)), active: true } });
        const source = { kind: 'execution_run' as const, machineId: machine.id, runId: 'detached-run' };
        const frontier: ExecutionRunFollowFrontierWitness = { source, status: 'succeeded', terminalEventId: 'settled-run',
            machineCustodianAccountId: account.id,
            target: { accountId: account.id, machineId: machine.id, installationId: machine.installationId! }, publisherGeneration: null };
        const input = { accountId: account.id, source, authentication: defaultAuthentication, executionRunFrontier: frontier };
        const once = [{ kind: 'run_settled' as const }];
        expect(await setOtherAccountFollow({ ...input, once })).toMatchObject({ ok: true,
            value: { follow: { source, following: false, persistent: false, once } } });
        expect(await getOtherAccountFollow(input)).toMatchObject({ ok: true, value: { follow: { source, once } } });
        expect(await getOtherAccountFollow({ ...input, accountId: other.id }))
            .toMatchObject({ ok: false, error: 'source_not_found' });
        expect(await listAccountSessionFollows({ accountId: account.id, authentication: defaultAuthentication }))
            .toMatchObject({ ok: true, value: { follows: [{ source, once }] } });
        expect(await inTx(tx => readOtherPersonalFollowerCensusInTx(tx, { accountId: other.id, source })))
            .toEqual({ peopleCount: 1, follows: [] });
        const current = resolveExecutionRunFollowOccurrenceV1({ ...frontier, sessionId: null, machineId: machine.id, runId: source.runId });
        if (!current) throw new Error('Expected retained terminal Run');
        const read = () => inTx(tx => readAccountRunFollowDeliveryInTx(tx, { ...input, ...current }));
        expect(await read()).toMatchObject({ represented: false });
        expect(await read()).toMatchObject({ represented: false });
        const accept = () => acceptAccountFollowPersonalProgress({ ...input, occurrence: { original: current.original } });
        const readFollowChange = async () => (await db.accountChange.findFirstOrThrow({ where: { accountId: account.id,
            entityId: ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID, kind: 'account' }, select: { cursor: true } })).cursor;
        const beforeAcceptance = await readFollowChange();
        expect(await accept()).toMatchObject({ ok: true, value: { accepted: true, alreadyRepresented: false } });
        const persisted = await db.accountSessionFollow.findFirstOrThrow({ where: { accountId: account.id } });
        const receipt = PersistedPersonalRunFollowOnceV1Schema.safeParse(JSON.parse(persisted.notifyOnce!));
        // Assert a boolean before examining the admitted value, so a bad
        // private caller context is never printed by a failed assertion.
        expect(receipt.success).toBe(true);
        if (receipt.success) {
            const fulfilled = receipt.data.intents[0];
            if (fulfilled?.state !== 'fulfilled') throw new Error('Expected fulfilled personal Run receipt');
            expect(Object.keys(fulfilled.occurrence).sort()).toEqual(['event', 'original']);
        }
        expect(await readFollowChange()).toBe(beforeAcceptance + 1);
        expect(await accept()).toMatchObject({ ok: true, value: { accepted: true, alreadyRepresented: true } });
        expect(await readFollowChange()).toBe(beforeAcceptance + 1);
        expect(await getOtherAccountFollow(input)).toMatchObject({ ok: true, value: { follow: { following: false, once: null } } });
        expect(await listAccountSessionFollows({ accountId: account.id, authentication: defaultAuthentication }))
            .toMatchObject({ ok: true, value: { follows: [{ following: false, once: null,
                onceDeliveries: [{ original: current.original, event: current.event }] }] } });
        expect(await inTx(tx => readOtherPersonalFollowerCensusInTx(tx, { accountId: account.id, source })))
            .toEqual({ peopleCount: 0, follows: [] });
        expect(await setOtherAccountFollow({ ...input, once: null })).toMatchObject({ ok: true });
        expect(await listAccountSessionFollows({ accountId: account.id, authentication: defaultAuthentication }))
            .toMatchObject({ ok: true, value: { follows: [] } });
        const ongoingSource = { ...source, runId: 'persistent-run' };
        const ongoingFrontier: ExecutionRunFollowFrontierWitness = { ...frontier, source: ongoingSource,
            status: 'running', terminalEventId: null };
        expect(await setOtherAccountFollow({ ...input, source: ongoingSource, policy: { preset: 'important' },
            executionRunFrontier: ongoingFrontier })).toMatchObject({ ok: true });
        const beforePureProgress = await readFollowChange();
        const terminalFrontier: ExecutionRunFollowFrontierWitness = { ...ongoingFrontier,
            status: 'succeeded', terminalEventId: 'persistent-terminal' };
        const ongoingTerminal = resolveExecutionRunFollowOccurrenceV1({ ...terminalFrontier, sessionId: null,
            machineId: machine.id, runId: ongoingSource.runId });
        if (!ongoingTerminal) throw new Error('Expected persistent Run terminal original');
        expect(await acceptAccountFollowPersonalProgress({ ...input, executionRunFrontier: terminalFrontier,
            occurrence: { original: ongoingTerminal.original } })).toMatchObject({ value: { accepted: true, alreadyRepresented: false } });
        expect(await readFollowChange()).toBe(beforePureProgress);
        expect(await removeOtherAccountFollow(input)).toMatchObject({ ok: true });
        const suppressed = await db.accountSessionFollow.findFirstOrThrow({ where: { accountId: account.id, sourceExecutionRunId: source.runId } });
        expect(await setOtherAccountFollow({ ...input, once })).toMatchObject({ ok: true,
            value: { follow: { following: false, persistent: true, once } } });
        const rearmed = await db.accountSessionFollow.findFirstOrThrow({ where: { accountId: account.id, sourceExecutionRunId: source.runId } });
        expect(rearmed.followPolicy).toBe(suppressed.followPolicy);
        expect(rearmed.voiceDeliveredFrontier).toBe(suppressed.voiceDeliveredFrontier);
        expect(rearmed.deliveredExecutionRunTerminalEventId).toBe(suppressed.deliveredExecutionRunTerminalEventId);
        await db.machine.update({ where: { id: machine.id }, data: { installationId: randomUUID() } });
        expect(await accept()).toMatchObject({ value: { accepted: false } });
        expect(await getOtherAccountFollow(input)).toMatchObject({ ok: true, value: { follow: { once } } });
    });

    it('preserves independent Run intents and persistent Voice policy while accepting an exact settled output', async () => {
        const account = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: account.id,
            installationId: randomUUID(), metadata: encodePlainMachineStoredContent({}),
            dataEncryptionKey: Uint8Array.from(decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER)), active: true } });
        const source = { kind: 'execution_run' as const, machineId: machine.id, runId: 'output-run' };
        const outputRef = { kind: 'review_walkthrough' as const, comparisonId: 'comparison', resultId: 'result' };
        const outputOnce = { kind: 'output_ready' as const, outputRef };
        const secondOutputRef = { kind: 'review_walkthrough' as const, comparisonId: 'second-comparison', resultId: 'second-result' };
        const secondOutputOnce = { kind: 'output_ready' as const, outputRef: secondOutputRef };
        const frontier: ExecutionRunFollowFrontierWitness = { source, status: 'running', terminalEventId: null,
            machineCustodianAccountId: account.id,
            outputs: [{ outputRef, revision: 3, state: 'writing' }, { outputRef: secondOutputRef, revision: 7, state: 'writing' }],
            target: { accountId: account.id, machineId: machine.id, installationId: machine.installationId! }, publisherGeneration: null };
        const input = { accountId: account.id, source, authentication: defaultAuthentication };
        const policy = { preset: 'quiet' as const, voice: true };
        expect(await setOtherAccountFollow({ ...input, policy, executionRunFrontier: frontier })).toMatchObject({ ok: true });
        const once = [{ kind: 'run_settled' as const }, { kind: 'first_needs_you' as const }, outputOnce, secondOutputOnce];
        expect(await setOtherAccountFollow({ ...input, once, executionRunFrontier: frontier }))
            .toMatchObject({ ok: true, value: { follow: { following: true, persistent: true, policy, once } } });
        const before = await db.accountSessionFollow.findFirstOrThrow({ where: { accountId: account.id } });
        expect(await setOtherAccountFollow({ ...input, once, executionRunFrontier: frontier }))
            .toMatchObject({ ok: true, value: { changed: false } });
        expect((await db.accountSessionFollow.findFirstOrThrow({ where: { accountId: account.id } })).notifyOnce).toBe(before.notifyOnce);
        const remaining = [{ kind: 'first_needs_you' as const }, outputOnce, secondOutputOnce];
        expect(await setOtherAccountFollow({ ...input, once: remaining, executionRunFrontier: frontier }))
            .toMatchObject({ ok: true, value: { follow: { policy, once: remaining } } });
        const outputOriginal = { source, output: { outputRef, revision: 4, state: 'partial' as const } };
        const accept = (executionRunFrontier: ExecutionRunFollowFrontierWitness) => acceptAccountFollowPersonalProgress({ ...input,
            executionRunFrontier, occurrence: { original: outputOriginal } });
        expect(await accept(frontier)).toMatchObject({ value: { accepted: false } });
        const settled: ExecutionRunFollowFrontierWitness = { ...frontier, outputs: [outputOriginal.output] };
        expect(await accept(settled)).toMatchObject({ value: { accepted: true, alreadyRepresented: false } });
        expect(await accept(settled)).toMatchObject({ value: { accepted: true, alreadyRepresented: true } });
        expect(await getOtherAccountFollow(input)).toMatchObject({ ok: true, value: { follow: {
            policy, following: true, once: [{ kind: 'first_needs_you' }, secondOutputOnce],
        } } });
        const active = [{ kind: 'first_needs_you' as const }, secondOutputOnce];
        expect(await setOtherAccountFollow({ ...input, once: [...active, { kind: 'run_settled' }], executionRunFrontier: settled }))
            .toMatchObject({ ok: true, value: { follow: { onceDeliveries: [{ original: outputOriginal }] } } });
        expect(await setOtherAccountFollow({ ...input, once: active }))
            .toMatchObject({ ok: true, value: { follow: { once: active, onceDeliveries: [{ original: outputOriginal }] } } });
        expect(await setOtherAccountFollow({ ...input, clearOnceDeliveries: true }))
            .toMatchObject({ ok: true, value: { follow: { once: active, policy } } });
        const cleared = await getOtherAccountFollow(input);
        expect(cleared.ok && cleared.value.follow?.onceDeliveries).toBeUndefined();
        const secondOutput = { outputRef: secondOutputRef, revision: 7, state: 'complete' as const };
        expect(await acceptAccountFollowPersonalProgress({ ...input, executionRunFrontier: { ...frontier, outputs: [secondOutput] },
            occurrence: { original: { source, output: secondOutput } } })).toMatchObject({ value: { accepted: false } });
        const secondReady = { ...secondOutput, revision: 8 };
        expect(await acceptAccountFollowPersonalProgress({ ...input, executionRunFrontier: { ...frontier, outputs: [secondReady] },
            occurrence: { original: { source, output: secondReady } } })).toMatchObject({ value: { accepted: true, alreadyRepresented: false } });
        expect(await getOtherAccountFollow(input)).toMatchObject({ ok: true, value: { follow: { once: [{ kind: 'first_needs_you' }] } } });
        expect(await setOtherAccountFollow({ ...input, once: null })).toMatchObject({ ok: true,
            value: { follow: { following: true, persistent: true, policy, once: null } } });
        const after = await db.accountSessionFollow.findFirstOrThrow({ where: { accountId: account.id } });
        expect(after.followPolicy).toBe(before.followPolicy);
        expect(after.voiceDeliveredFrontier).toBe(before.voiceDeliveredFrontier);
        // A newly requested already-settled output catches up immediately;
        // the source baseline must not accidentally discard its own current value.
        expect(await setOtherAccountFollow({ ...input, once: [outputOnce], executionRunFrontier: settled })).toMatchObject({ ok: true });
        expect(await accept(settled)).toMatchObject({ value: { accepted: true, alreadyRepresented: false } });
        expect(await setOtherAccountFollow({ ...input, once: [{ ...outputOnce, afterRevision: 4 }], executionRunFrontier: settled }))
            .toMatchObject({ ok: true });
        expect(await accept(settled)).toMatchObject({ value: { accepted: false } });
    });

    it('arms and cancels a one-shot without changing suppression, Voice or private read progress', async () => {
        const { session, key } = await fixture();
        await removeAccountSessionFollow(key);
        await db.session.update({ where: { id: session.id }, data: { latestTurnId: 'turn-once', latestTurnStatus: 'in_progress' } });
        const before = await db.accountSessionFollow.findUniqueOrThrow({ where: { accountId_sessionId: key } });
        const armed = await setAccountSessionFollow({ ...key, preferences: { once: { kind: 'turn_finished', sourceTurnId: 'turn-once' } } });
        expect(armed).toMatchObject({ ok: true, value: { follow: {
            following: false, notificationLevel: 'none', includeInVoice: false,
            once: { kind: 'turn_finished', sourceTurnId: 'turn-once' },
        } } });
        const after = await db.accountSessionFollow.findUniqueOrThrow({ where: { accountId_sessionId: key } });
        expect(after.voiceDeliveredFrontier).toBe(before.voiceDeliveredFrontier);
        expect(await db.accountSessionReadState.findUnique({ where: { accountId_sessionId: key } })).toBeNull();
        expect(await setAccountSessionFollow({ ...key, preferences: { once: null } }))
            .toMatchObject({ ok: true, value: { follow: { following: false, once: null } } });
    });

    it('consumes only an accepted matching occurrence and does not consume a re-armed choice on retry', async () => {
        const { session, key } = await fixture();
        await db.session.update({ where: { id: session.id }, data: { latestTurnId: 'turn-once', latestTurnStatus: 'in_progress' } });
        await setAccountSessionFollow({ ...key, preferences: { once: { kind: 'turn_finished', sourceTurnId: 'turn-once' } } });
        const armed = await db.accountSessionFollow.findUniqueOrThrow({ where: { accountId_sessionId: key } });
        const consume = (event: 'ready' | 'failed' | 'cancelled', turnId: string, accepted: boolean) => inTx(tx => consumeAccountSessionFollowOnceInTx(tx, {
            ...key, expectedOnce: armed.notifyOnce!, accepted,
            occurrence: { event, turnId, agentStateVersion: 1 },
        }));
        expect(await consume('ready', 'next-turn', true)).toBe(false);
        expect(await consume('failed', 'turn-once', false)).toBe(false);
        expect(await consume('cancelled', 'turn-once', true)).toBe(true);
        expect(await consume('cancelled', 'turn-once', true)).toBe(false);
        await setAccountSessionFollow({ ...key, preferences: { once: { kind: 'first_needs_you' } } });
        expect(await consume('ready', 'turn-once', true)).toBe(false);
        expect((await getAccountSessionFollow(key))).toMatchObject({ ok: true, value: { follow: { once: { kind: 'first_needs_you' } } } });
    });

    it('does not consume candidate reads and accepts an Inbox effect exactly once', async () => {
        const { listSessionPersonalEventRecipients } = await import('@/app/session/personal/eventEligibility');
        const { session, key } = await fixture();
        await removeAccountSessionFollow(key);
        await db.session.update({ where: { id: session.id }, data: { latestTurnId: 'turn-once', latestTurnStatus: 'in_progress' } });
        await setAccountSessionFollow({ ...key, preferences: { once: { kind: 'turn_finished', sourceTurnId: 'turn-once' } } });
        await db.session.update({ where: { id: session.id }, data: { latestTurnStatus: 'completed' } });
        await db.sessionTurn.create({ data: { sessionId: session.id, turnId: 'turn-once', status: 'completed', startedAt: 1, updatedAt: 2, terminalAt: 2 } });
        const occurrence = { event: 'ready' as const, turnId: 'turn-once', agentStateVersion: 0, transcriptSeq: session.seq };
        const candidates = await listSessionPersonalEventRecipients({ sessionId: session.id, event: 'ready', onceOccurrence: occurrence });
        expect(candidates.find(row => row.accountId === key.accountId)).toMatchObject({ reason: 'follow_once' });
        await listSessionPersonalEventRecipients({ sessionId: session.id, event: 'ready', onceOccurrence: occurrence });
        expect((await getAccountSessionFollow(key))).toMatchObject({ ok: true, value: { follow: { once: { kind: 'turn_finished' } } } });
        const once = candidates.find(row => row.accountId === key.accountId)?.once;
        if (!once) throw new Error('Expected exact one-shot candidate');
        // A later turn does not revoke the completed original source witness.
        await db.session.update({ where: { id: session.id }, data: { latestTurnId: 'next-turn', latestTurnStatus: 'in_progress' } });
        expect(await acceptAccountSessionFollowOnceDelivery({ ...key, ...once })).toBe(true);
        expect(await acceptAccountSessionFollowOnceDelivery({ ...key, ...once })).toBe(false);
        expect((await getAccountSessionFollow(key))).toMatchObject({ ok: true, value: { follow: {
            following: false, once: null, onceDelivery: occurrence,
        } } });
        const { applyViewerReadCursorOperation } = await import('@/app/session/personal/readState');
        expect(await applyViewerReadCursorOperation({ ...key, authentication: defaultAuthentication,
            operation: { kind: 'mark-read' } })).toMatchObject({ ok: true });
        const afterRead = await getAccountSessionFollow(key);
        expect(afterRead.ok && afterRead.value.follow?.onceDelivery).toBeUndefined();
        expect(afterRead).toMatchObject({ ok: true, value: { follow: { following: false } } });
    });

    it('keeps a first-request intent armed when a later revision cannot prove its exact current request', async () => {
        const { session, key } = await fixture();
        await db.sessionGrant.updateMany({ where: { principalKind: 'account', sessionId: session.id, accountId: key.accountId }, data: { accessLevel: 'edit' } });
        await setAccountSessionFollow({ ...key, preferences: { once: { kind: 'first_needs_you' } } });
        const armed = await db.accountSessionFollow.findUniqueOrThrow({ where: { accountId_sessionId: key } });
        if (!armed.notifyOnce) throw new Error('Expected armed one-shot');
        const occurrence = { event: 'user_action_required' as const, requestId: 'original-request', agentStateVersion: session.agentStateVersion + 1 };
        await db.session.update({ where: { id: session.id }, data: { agentStateVersion: occurrence.agentStateVersion + 1 } });
        expect(await acceptAccountSessionFollowOnceDelivery({ ...key, expectedOnce: armed.notifyOnce, occurrence })).toBe(false);
        expect((await getAccountSessionFollow(key))).toMatchObject({ ok: true, value: { follow: { once: { kind: 'first_needs_you' } } } });
    });

    it('accepts the exact original request transaction once before a later withdrawal can hide its source', async () => {
        const { acceptSessionPersonalEventOnceInTx } = await import('@/app/session/personal/eventEligibility');
        const { session, key } = await fixture();
        await db.sessionGrant.updateMany({ where: { principalKind: 'account', sessionId: session.id, accountId: key.accountId }, data: { accessLevel: 'edit' } });
        await removeAccountSessionFollow(key);
        await setAccountSessionFollow({ ...key, preferences: { once: { kind: 'first_needs_you' } } });
        const occurrence = { event: 'user_action_required' as const, requestId: 'original-request', agentStateVersion: session.agentStateVersion + 1 };
        const input = { sessionId: session.id, event: occurrence.event, onceOccurrence: occurrence };
        const accepted = await inTx(async tx => {
            await tx.session.update({ where: { id: session.id }, data: { agentStateVersion: occurrence.agentStateVersion, pendingUserActionRequestCount: 1 } });
            return acceptSessionPersonalEventOnceInTx(tx, input);
        });
        expect(accepted).toContain(key.accountId);
        await db.session.update({ where: { id: session.id }, data: { agentStateVersion: occurrence.agentStateVersion + 1, pendingUserActionRequestCount: 0 } });
        expect(await inTx(tx => acceptSessionPersonalEventOnceInTx(tx, input))).toEqual([]);
        expect((await getAccountSessionFollow(key))).toMatchObject({ ok: true, value: { follow: { following: false, once: null, onceDelivery: occurrence } } });
    });

    it('keeps a source-muted first-request one-shot armed instead of accepting personal delivery', async () => {
        const { acceptSessionPersonalEventOnceInTx } = await import('@/app/session/personal/eventEligibility');
        const { changeDeliveryMute } = await import('./sessionDeliveryMuteService');
        const { session, key } = await fixture();
        await db.sessionGrant.updateMany({ where: { principalKind: 'account', sessionId: session.id, accountId: key.accountId }, data: { accessLevel: 'edit' } });
        await setAccountSessionFollow({ ...key, preferences: { once: { kind: 'first_needs_you' } } });
        await changeDeliveryMute({ accountId: key.accountId, receiver: { kind: 'account' },
            scope: { kind: 'source', source: { kind: 'session', sessionId: session.id } },
            operation: 'set', authentication: defaultAuthentication });
        const occurrence = { event: 'user_action_required' as const, requestId: 'muted-request', agentStateVersion: session.agentStateVersion + 1 };
        const accepted = await inTx(async tx => {
            await tx.session.update({ where: { id: session.id }, data: { agentStateVersion: occurrence.agentStateVersion, pendingUserActionRequestCount: 1 } });
            return acceptSessionPersonalEventOnceInTx(tx, { sessionId: session.id, event: occurrence.event, onceOccurrence: occurrence });
        });
        expect(accepted).not.toContain(key.accountId);
        expect((await getAccountSessionFollow(key))).toMatchObject({ ok: true, value: { follow: { once: { kind: 'first_needs_you' } } } });
    });

    it('rechecks source mute before accepting a previously listed terminal one-shot', async () => {
        const { listSessionPersonalEventRecipients } = await import('@/app/session/personal/eventEligibility');
        const { changeDeliveryMute } = await import('./sessionDeliveryMuteService');
        const { session, key } = await fixture();
        await removeAccountSessionFollow(key);
        await db.session.update({ where: { id: session.id }, data: { latestTurnId: 'muted-terminal', latestTurnStatus: 'in_progress' } });
        await setAccountSessionFollow({ ...key, preferences: { once: { kind: 'turn_finished', sourceTurnId: 'muted-terminal' } } });
        await db.sessionTurn.create({ data: { sessionId: session.id, turnId: 'muted-terminal', status: 'completed', startedAt: 1, updatedAt: 2, terminalAt: 2 } });
        const occurrence = { event: 'ready' as const, turnId: 'muted-terminal', agentStateVersion: session.agentStateVersion };
        const candidate = (await listSessionPersonalEventRecipients({ sessionId: session.id, event: 'ready', onceOccurrence: occurrence }))
            .find(row => row.accountId === key.accountId);
        if (!candidate?.once) throw new Error('Expected an unmuted one-shot candidate');
        expect(await changeDeliveryMute({ accountId: key.accountId, receiver: { kind: 'account' },
            scope: { kind: 'source', source: { kind: 'session', sessionId: session.id } },
            operation: 'set', authentication: defaultAuthentication })).toMatchObject({ ok: true });
        expect(await acceptAccountSessionFollowOnceDelivery({ ...key, ...candidate.once })).toBe(false);
        expect((await getAccountSessionFollow(key))).toMatchObject({ ok: true, value: { follow: { once: { kind: 'turn_finished' } } } });
        expect(await changeDeliveryMute({ accountId: key.accountId, receiver: { kind: 'account' },
            scope: { kind: 'source', source: { kind: 'session', sessionId: session.id } },
            operation: 'remove', authentication: defaultAuthentication })).toMatchObject({ ok: true });
        expect(await acceptAccountSessionFollowOnceDelivery({ ...key, ...candidate.once })).toBe(true);
        expect(await acceptAccountSessionFollowOnceDelivery({ ...key, ...candidate.once })).toBe(false);
    });

    it('atomically replaces durable Voice inclusions while preserving Follow preferences', async () => {
        const { owner, viewer, session, key } = await fixture();
        const second = await db.session.create({ data: {
            accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', seq: 11,
        } });
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: second.id, createdByAccountId: owner.id, accountId: viewer.id, accessLevel: 'view',
        } });
        await setAccountSessionFollow({ ...key, preferences: { notificationLevel: 'important', includeInVoice: true } });
        await setAccountSessionFollow({
            accountId: viewer.id,
            sessionId: second.id,
            preferences: { notificationLevel: 'all_messages', includeInVoice: false },
        });

        await expect(replaceAccountSessionVoiceInclusions({ accountId: viewer.id, sessionIds: [second.id] }))
            .resolves.toEqual({ ok: true, value: { changed: true, sessionIds: [second.id] } });
        expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: key } }))
            .toMatchObject({ following: true, followPolicy: JSON.stringify({ preset: 'important', voice: false }), includeInVoice: false });
        expect(await db.accountSessionFollow.findUnique({ where: {
            accountId_sessionId: { accountId: viewer.id, sessionId: second.id },
        } })).toMatchObject({ following: true, followPolicy: JSON.stringify({ preset: 'everything', voice: true }), includeInVoice: false });

        await expect(replaceAccountSessionVoiceInclusions({ accountId: viewer.id, sessionIds: [] }))
            .resolves.toMatchObject({ ok: true, value: { changed: true, sessionIds: [] } });
        expect(await db.accountSessionFollow.findMany({ where: { accountId: viewer.id, includeInVoice: true } })).toEqual([]);
    });

    it('replaces Session Voice inclusions without rewriting a generic source policy', async () => {
        const { viewer, session, key } = await fixture();
        const discussion = await createDiscussion({ sessionId: session.id, creatorAccountId: viewer.id, messageSeq: 1 });
        const source = { kind: 'discussion' as const, discussionId: discussion.id };
        const policy = { preset: 'important' as const, voice: true };
        expect(await setOtherAccountFollow({ accountId: viewer.id, source, policy, authentication: defaultAuthentication }))
            .toMatchObject({ ok: true });
        expect(await replaceAccountSessionVoiceInclusions({ accountId: viewer.id, sessionIds: [key.sessionId] }))
            .toMatchObject({ ok: true, value: { sessionIds: [key.sessionId] } });
        expect(await replaceAccountSessionVoiceInclusions({ accountId: viewer.id, sessionIds: [] }))
            .toMatchObject({ ok: true, value: { sessionIds: [] } });
        expect(await db.accountSessionFollow.findUnique({ where: { accountId_sourceKey: {
            accountId: viewer.id, sourceKey: `discussion:${discussion.id}`,
        } } })).toMatchObject({ following: true, followPolicy: JSON.stringify(policy) });
    });

    it('validates the complete replacement before mutating durable Voice inclusions', async () => {
        const { viewer, key } = await fixture();
        await setAccountSessionFollow({ ...key, preferences: { notificationLevel: 'important', includeInVoice: true } });
        await expect(replaceAccountSessionVoiceInclusions({ accountId: viewer.id, sessionIds: [key.sessionId, 'missing'] }))
            .resolves.toEqual({ ok: false, error: 'session_not_found' });
        expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: key } }))
            .toMatchObject({ following: true, followPolicy: JSON.stringify({ preset: 'important', voice: true }), includeInVoice: false });
    });

    it('replaces modern Voice inclusions through their event policy without changing event selection', async () => {
        const { key } = await fixture();
        await setAccountSessionFollow({ ...key, preferences: { policy: { preset: 'custom', events: {
            finished: { delivery: 'quiet', voice: true }, message: { delivery: 'off', voice: true },
        } } } });
        await expect(replaceAccountSessionVoiceInclusions({ accountId: key.accountId, sessionIds: [] }))
            .resolves.toMatchObject({ ok: true, value: { changed: true, sessionIds: [] } });
        expect(await getAccountSessionFollow(key)).toMatchObject({ ok: true, value: { follow: { includeInVoice: false,
            policy: { preset: 'custom', events: { finished: { delivery: 'quiet', voice: false }, message: { delivery: 'off', voice: false } } },
        } } });
        await expect(replaceAccountSessionVoiceInclusions({ accountId: key.accountId, sessionIds: [key.sessionId] }))
            .resolves.toMatchObject({ ok: true, value: { changed: true, sessionIds: [key.sessionId] } });
        expect(await getAccountSessionFollow(key)).toMatchObject({ ok: true, value: { follow: { includeInVoice: true,
            policy: { preset: 'custom', events: { finished: { delivery: 'quiet', voice: true }, message: { delivery: 'off', voice: true } } },
        } } });
        expect(await db.accountSessionFollow.findUniqueOrThrow({ where: { accountId_sessionId: key } })).toMatchObject({ includeInVoice: false });
        await setAccountSessionFollow({ ...key, preferences: { policy: { preset: 'custom', events: {
            finished: { delivery: 'off' },
        } } } });
        expect(await getAccountSessionFollow(key)).toMatchObject({ ok: true, value: { follow: { includeInVoice: false } } });
        expect(await replaceAccountSessionVoiceInclusions({ accountId: key.accountId, sessionIds: [key.sessionId] }))
            .toMatchObject({ ok: true, value: { sessionIds: [key.sessionId] } });
        expect(await getAccountSessionFollow(key)).toMatchObject({ ok: true, value: { follow: { includeInVoice: true,
            policy: { preset: 'custom', events: { finished: { delivery: 'off', voice: true } } },
        } } });
        expect(await replaceAccountSessionVoiceInclusions({ accountId: key.accountId, sessionIds: [key.sessionId] }))
            .toMatchObject({ ok: true, value: { changed: false, sessionIds: [key.sessionId] } });
    });

    it('refreshes the affected Account badge after committed Follow choices and stays quiet on no-op', async () => {
        const { owner, key } = await fixture();
        const token = `ExponentPushToken[${key.accountId}]`;
        await db.accountPushToken.createMany({ data: [
            { accountId: key.accountId, token },
            { accountId: owner.id, token: `ExponentPushToken[${owner.id}]` },
        ] });
        const preferences = { notificationLevel: 'important' as const, includeInVoice: false };
        const expectBadge = async (badge: number) => {
            await vi.waitFor(() => expect(sendPushNotificationsAsync.mock.calls.flatMap(([messages]) => messages))
                .toEqual([{ to: token, badge, data: { type: 'badge_refresh' } }]));
            sendPushNotificationsAsync.mockClear();
        };
        sendPushNotificationsAsync.mockClear();
        await setAccountSessionFollow({ ...key, preferences });
        await expectBadge(0);
        await db.accountSessionReadState.update({ where: { accountId_sessionId: key }, data: { lastViewedSessionSeq: 5 } });
        await setAccountSessionFollow({ ...key, preferences: { ...preferences, notificationLevel: 'all_messages' } });
        await expectBadge(1);
        await removeAccountSessionFollow(key);
        await expectBadge(0);
        expect(await removeAccountSessionFollow(key)).toEqual({ ok: true, value: { changed: false } });
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(sendPushNotificationsAsync.mock.calls.flatMap(([messages]) => messages)).toEqual([]);
    });


    it('removes final-access Follows and invalidates the exact affected Account set', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const viewers = await Promise.all([0, 1, 2].map(() => db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } })));
        const viewerIds = viewers.map(viewer => viewer.id);
        const session = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', seq: 10 } });
        for (const viewer of viewers) {
            await db.sessionGrant.create({ data: { principalKind: 'account', sessionId: session.id, createdByAccountId: owner.id, accountId: viewer.id, accessLevel: 'view' } });
        }
        for (const viewerId of viewerIds) {
            await setAccountSessionFollow({ accountId: viewerId, sessionId: session.id, preferences: { notificationLevel: 'important', includeInVoice: false } });
        }
        const tokens = new Map(viewerIds.map(viewerId => [viewerId, `ExponentPushToken[${viewerId}]`] as const));
        await db.accountPushToken.createMany({ data: [...tokens].map(([accountId, token]) => ({ accountId, token })) });
        const bystander = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const bystanderToken = `ExponentPushToken[${bystander.id}]`;
        await db.accountPushToken.create({ data: { accountId: bystander.id, token: bystanderToken } });
        // Let Follow-creation badge refreshes flush so the access-loss phase is observed alone.
        await new Promise(resolve => setTimeout(resolve, 100));
        sendPushNotificationsAsync.mockClear();
        // Revoke every direct share so the next call observes final access loss.
        await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: session.id } });

        const removed = await inTx(tx => removeAccountSessionFollowsOnAccessLossInTx(tx, {
            sessionId: session.id, accountIds: viewerIds,
        }));
        expect(removed).toBe(viewerIds.length);
        // All active Follows disappear.
        expect(await db.accountSessionFollow.findMany({ where: { sessionId: session.id } })).toEqual([]);
        // Each affected Account receives the current coarse Follow hint.
        for (const viewerId of viewerIds) {
            await expect(db.accountChange.findFirst({ where: { accountId: viewerId, kind: 'account', entityId: 'session-follows' }, select: { hint: true } }))
                .resolves.toMatchObject({ hint: { sessionFollows: true, full: true } });
        }
        // Badge refresh scheduling covers the exact full Account set through the real transport.
        await vi.waitFor(() => {
            const delivered = sendPushNotificationsAsync.mock.calls.flatMap(([messages]) => messages as Array<{ to: string }>);
            expect(new Set(delivered.map(message => message.to))).toEqual(new Set(tokens.values()));
        });
        const deliveredTokens = new Set(sendPushNotificationsAsync.mock.calls.flatMap(([messages]) => (messages as Array<{ to: string }>).map(message => message.to)));
        expect(deliveredTokens.has(bystanderToken)).toBe(false);
        // Repeating after final loss is a no-op.
        expect(await inTx(tx => removeAccountSessionFollowsOnAccessLossInTx(tx, { sessionId: session.id, accountIds: viewerIds }))).toBe(0);
    });

    it('projects create, update, Unfollow, and refollow into the Following list predicate', async () => {
        const { key, session } = await fixture();
        const followingIds = async () => (await db.session.findMany({
            where: await createSessionListScopeWhere({ accountId: key.accountId, scope: 'following' }),
            select: { id: true },
        })).map((row) => row.id);

        expect(await followingIds()).toEqual([]);
        await setAccountSessionFollow({
            ...key,
            preferences: { notificationLevel: 'important', includeInVoice: false },
        });
        expect(await followingIds()).toEqual([session.id]);
        await setAccountSessionFollow({
            ...key,
            preferences: { notificationLevel: 'all_messages', includeInVoice: true },
        });
        expect(await followingIds()).toEqual([session.id]);
        await removeAccountSessionFollow(key);
        expect(await followingIds()).toEqual([]);
        await setAccountSessionFollow({
            ...key,
            preferences: { notificationLevel: 'important', includeInVoice: false },
        });
        expect(await followingIds()).toEqual([session.id]);
    });

    it('seeds re-entry at current but preserves owner and already tracked unread state', async () => {
        const { owner, key, session } = await fixture();
        await db.accountSessionReadState.create({ data: { ...key, lastViewedSessionSeq: 2, unreadSince: new Date(1000) } });
        const preferences = { notificationLevel: 'important' as const, includeInVoice: false };
        expect(await setAccountSessionFollow({ ...key, preferences })).toMatchObject({ ok: true });
        expect(await db.accountSessionReadState.findUnique({ where: { accountId_sessionId: key } })).toMatchObject({ lastViewedSessionSeq: 10, unreadSince: null });
        await db.accountSessionReadState.update({ where: { accountId_sessionId: key }, data: { lastViewedSessionSeq: 5, unreadSince: new Date(2000) } });
        await setAccountSessionFollow({ ...key, preferences: { ...preferences, notificationLevel: 'all_messages' } });
        expect(await db.accountSessionReadState.findUnique({ where: { accountId_sessionId: key } })).toMatchObject({ lastViewedSessionSeq: 5, unreadSince: new Date(2000) });
        await removeAccountSessionFollow(key);
        await db.session.update({ where: { id: session.id }, data: { seq: 20 } });
        await setAccountSessionFollow({ ...key, preferences });
        expect(await db.accountSessionReadState.findUnique({ where: { accountId_sessionId: key } })).toMatchObject({ lastViewedSessionSeq: 20, unreadSince: null });
        const ownerKey = { accountId: owner.id, sessionId: session.id };
        await db.accountSessionReadState.create({ data: { ...ownerKey, lastViewedSessionSeq: 3, unreadSince: new Date(3000) } });
        await setAccountSessionFollow({ ...ownerKey, preferences });
        expect(await db.accountSessionReadState.findUnique({ where: { accountId_sessionId: ownerKey } })).toMatchObject({ lastViewedSessionSeq: 3, unreadSince: new Date(3000) });
    });




    it('preserves acknowledged Voice on true→true and resets only disable/re-enable', async () => {
        const { key } = await fixture();
        const preferences = { notificationLevel: 'none' as const, includeInVoice: true };
        await setAccountSessionFollow({ ...key, preferences });
        const frontier = JSON.stringify({ v: 1, transcriptSeq: 10, readyEventSeq: 0, agentStateVersion: 0, turn: null });
        await db.accountSessionFollow.update({ where: { accountId_sessionId: key }, data: { voiceDeliveredFrontier: frontier } });
        await setAccountSessionFollow({ ...key, preferences: { ...preferences, notificationLevel: 'important' } });
        expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: key } })).toMatchObject({ voiceDeliveredFrontier: frontier });
        await setAccountSessionFollow({ ...key, preferences: { ...preferences, includeInVoice: false } });
        await setAccountSessionFollow({ ...key, preferences });
        expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: key } })).toMatchObject({ voiceDeliveredFrontier: null });
    });

    it('normalizes scalar Voice ingress into policy and lets modern edits replace that authority', async () => {
        const { key } = await fixture();
        for (const notificationLevel of ['important', 'none'] as const) {
            await setAccountSessionFollow({ ...key, preferences: { policy: { preset: 'quiet' } } });
            expect(await setAccountSessionFollow({ ...key, preferences: { notificationLevel, includeInVoice: true } }))
                .toMatchObject({ ok: true, value: { follow: { includeInVoice: true }, voiceInitialSnapshotPending: true } });
            expect(await db.accountSessionFollow.findUniqueOrThrow({ where: { accountId_sessionId: key } }))
                .toMatchObject({ includeInVoice: false,
                    followPolicy: JSON.stringify(normalizeAccountFollowNotificationChoiceV1({ notificationLevel, includeInVoice: true })) });
        }
        expect(await setAccountSessionFollow({ ...key, preferences: { policy: { preset: 'important' }, includeInVoice: true } }))
            .toMatchObject({ ok: true, value: { follow: { includeInVoice: false } } });
        expect(await db.accountSessionFollow.findUniqueOrThrow({ where: { accountId_sessionId: key } }))
            .toMatchObject({ includeInVoice: false, followPolicy: JSON.stringify({ preset: 'important' }) });
    });

    it('admits explicit policy Voice and rechecks policy withdrawal before accepted frontier mutation', async () => {
        const { viewer, session, key } = await fixture();
        const voiceSession = await db.session.create({ data: {
            accountId: viewer.id, tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
            metadata: '{}', encryptionMode: 'plain',
        } });
        const runtimeAuthority = { executionRunId: 'voice-run-policy', occurrenceId: 'voice-occurrence-policy',
            parentSessionId: voiceSession.id, intent: 'voice_agent' as const, runtimeState: 'active_turn' as const };
        await setAccountSessionFollow({ ...key, preferences: { notificationLevel: 'important', includeInVoice: true } });
        await setAccountSessionFollow({ ...key, preferences: { policy: { preset: 'custom', events: {
            finished: { delivery: 'quiet', voice: true },
        } } } });
        const observe = () => inTx(tx => observePendingAccountVoiceFollowInTx(tx, {
            accountId: viewer.id, voiceSessionId: voiceSession.id, authentication: defaultAuthentication, runtimeAuthority,
        }));
        const pending = await observe();
        expect(pending).toEqual([expect.objectContaining({ sourceSessionId: session.id, expected: null })]);
        expect(await getAccountSessionFollow(key)).toMatchObject({ ok: true, value: { voiceInitialSnapshotPending: true } });
        const acceptance = { localInputId: 'accepted-policy-voice', userMessageSeq: 1 };
        await db.sessionMessage.create({ data: {
            sessionId: voiceSession.id, seq: 1, localId: acceptance.localInputId, messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'Voice turn' } } },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: viewer.id, sessionRelationship: 'owner' },
        } });
        if (!pending?.[0]) throw new Error('Expected source admitted for Voice');
        const acknowledge = (policy = pending[0]!.policy) => inTx(tx => acknowledgeAccountVoiceFollowInTx(tx, {
            accountId: viewer.id, voiceSessionId: voiceSession.id, sourceSessionId: session.id,
            expected: null, observed: pending[0]!.observed, consumed: pending[0]!.observed, policy,
            acceptance, authentication: defaultAuthentication, runtimeAuthority,
        }));
        expect(pending[0]!.policy).toEqual({ preset: 'custom', events: { finished: { delivery: 'quiet', voice: true } } });
        const mute = { accountId: viewer.id, receiver: { kind: 'account' as const },
            scope: { kind: 'sender_session' as const, sessionId: session.id }, authentication: defaultAuthentication };
        expect(await changeDeliveryMute({ ...mute, operation: 'set' })).toMatchObject({ ok: true });
        expect(await observe()).toEqual([]);
        expect(await acknowledge()).toEqual({ ok: false, rejection: 'not_followed' });
        expect(await getAccountSessionFollow(key)).toMatchObject({ ok: true, value: { follow: { following: true } } });
        expect(await changeDeliveryMute({ ...mute, operation: 'remove' })).toMatchObject({ ok: true });
        expect(await observe()).toEqual(pending);
        await setAccountSessionFollow({ ...key, preferences: { policy: { preset: 'custom', events: {
            finished: { delivery: 'interrupt', voice: true },
        } } } });
        expect(await acknowledge()).toEqual({ ok: false, rejection: 'stale_expected_frontier' });
        await setAccountSessionFollow({ ...key, preferences: { policy: { preset: 'quiet' } } });
        expect(await observe()).toEqual([]);
        expect(await inTx(tx => acknowledgeAccountVoiceFollowInTx(tx, {
            accountId: viewer.id, voiceSessionId: voiceSession.id, sourceSessionId: session.id,
            expected: null, observed: pending[0]!.observed, consumed: pending[0]!.observed,
            acceptance, authentication: defaultAuthentication, runtimeAuthority,
        }))).toEqual({ ok: false, rejection: 'not_followed' });
        expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: key } }))
            .toMatchObject({ voiceDeliveredFrontier: null });
        await setAccountSessionFollow({ ...key, preferences: { policy: pending[0]!.policy } });
        expect(await acknowledge()).toMatchObject({ ok: true, delivered: pending[0]!.observed });
        expect(await observe()).toEqual([]);
        await inTx(tx => transitionSessionArchiveStateInTx({ tx, sessionId: session.id, wasArchived: false, archivedAt: new Date() }));
        await inTx(tx => transitionSessionArchiveStateInTx({ tx, sessionId: session.id, wasArchived: true, archivedAt: null }));
        expect(await observe()).toEqual([expect.objectContaining({ sourceSessionId: session.id, expected: null, policy: pending[0]!.policy })]);
    });

    it('delivers one pending-current Voice snapshot and advances only its exact accepted frontier', async () => {
        const { viewer, session, key } = await fixture();
        const ordinarySession = await db.session.create({ data: {
            accountId: viewer.id,
            tag: randomUUID(),
            metadata: '{}',
            encryptionMode: 'plain',
        } });
        const voiceSession = await db.session.create({ data: {
            accountId: viewer.id,
            tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
            metadata: '{}',
            encryptionMode: 'plain',
        } });
        await setAccountSessionFollow({
            ...key,
            preferences: { notificationLevel: 'none', includeInVoice: true },
        });
        const runtimeAuthority = {
            executionRunId: 'voice-run-current',
            occurrenceId: 'voice-occurrence-current',
            parentSessionId: voiceSession.id,
            intent: 'voice_agent' as const,
            runtimeState: 'active_turn' as const,
        };
        expect(await inTx((tx) => observePendingAccountVoiceFollowInTx(tx, {
            accountId: viewer.id,
            voiceSessionId: ordinarySession.id,
            authentication: defaultAuthentication,
            runtimeAuthority: { ...runtimeAuthority, parentSessionId: ordinarySession.id },
        }))).toBeNull();
        const observe = () => inTx((tx) => observePendingAccountVoiceFollowInTx(tx, {
            accountId: viewer.id,
            voiceSessionId: voiceSession.id,
            authentication: defaultAuthentication,
            runtimeAuthority,
        }));
        const pending = await observe();
        expect(pending).toEqual([expect.objectContaining({
            sourceSessionId: session.id,
            voiceSessionId: voiceSession.id,
            expected: null,
            observed: expect.objectContaining({ transcriptSeq: 10 }),
        })]);
        if (pending === null) throw new Error('Expected a pending Account Voice Follow observation');
        expect(await getAccountSessionFollow(key)).toMatchObject({
            ok: true,
            value: { voiceInitialSnapshotPending: true },
        });
        const acceptance = { localInputId: 'accepted-voice-follow-input', userMessageSeq: 1 } as const;
        expect(await inTx((tx) => acknowledgeAccountVoiceFollowInTx(tx, {
            accountId: viewer.id,
            voiceSessionId: voiceSession.id,
            sourceSessionId: session.id,
            expected: null,
            observed: pending[0]!.observed,
            consumed: pending[0]!.observed,
            policy: pending[0]!.policy,
            acceptance,
            authentication: defaultAuthentication,
            runtimeAuthority,
        }))).toEqual({ ok: false, rejection: 'provider_acceptance_unverified' });
        await db.sessionMessage.create({ data: {
            sessionId: voiceSession.id,
            seq: 1,
            localId: acceptance.localInputId,
            messageRole: 'user',
            content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: 'voice turn' } } },
            inputAdmissionReceipt: { v: 1, issuer: 'authenticatedAccount', actorAccountId: viewer.id, sessionRelationship: 'owner' },
        } });
        expect(await inTx((tx) => acknowledgeAccountVoiceFollowInTx(tx, {
            accountId: viewer.id,
            voiceSessionId: voiceSession.id,
            sourceSessionId: session.id,
            expected: null,
            observed: pending[0]!.observed,
            consumed: pending[0]!.observed,
            policy: pending[0]!.policy,
            acceptance,
            authentication: defaultAuthentication,
            runtimeAuthority,
        }))).toEqual({ ok: true, delivered: pending[0]!.observed });
        expect(await observe()).toEqual([]);
        expect(await getAccountSessionFollow(key)).toMatchObject({
            ok: true,
            value: { voiceInitialSnapshotPending: false },
        });

        await db.session.update({ where: { id: session.id }, data: { seq: 11 } });
        const advanced = await observe();
        expect(advanced).toHaveLength(1);
        if (advanced === null) throw new Error('Expected an advanced Account Voice Follow observation');
        await db.session.update({ where: { id: session.id }, data: { seq: 12 } });
        expect(await inTx((tx) => acknowledgeAccountVoiceFollowInTx(tx, {
            accountId: viewer.id,
            voiceSessionId: voiceSession.id,
            sourceSessionId: session.id,
            expected: advanced[0]!.expected,
            observed: advanced[0]!.observed,
            consumed: { ...advanced[0]!.observed, transcriptSeq: 12 },
            policy: advanced[0]!.policy,
            acceptance,
            authentication: defaultAuthentication,
            runtimeAuthority,
        }))).toEqual({ ok: false, rejection: 'invalid_consumed_frontier' });
        expect(await inTx((tx) => acknowledgeAccountVoiceFollowInTx(tx, {
            accountId: viewer.id,
            voiceSessionId: voiceSession.id,
            sourceSessionId: session.id,
            expected: advanced[0]!.expected,
            observed: advanced[0]!.observed,
            consumed: advanced[0]!.observed,
            policy: advanced[0]!.policy,
            acceptance,
            authentication: defaultAuthentication,
            runtimeAuthority,
        }))).toEqual({ ok: true, delivered: advanced[0]!.observed });
        expect(await observe()).toEqual([expect.objectContaining({
            expected: advanced[0]!.observed,
            observed: expect.objectContaining({ transcriptSeq: 12 }),
        })]);
        expect(await inTx((tx) => acknowledgeAccountVoiceFollowInTx(tx, {
            accountId: viewer.id,
            voiceSessionId: voiceSession.id,
            sourceSessionId: session.id,
            expected: null,
            observed: advanced[0]!.observed,
            consumed: advanced[0]!.observed,
            policy: advanced[0]!.policy,
            acceptance,
            authentication: defaultAuthentication,
            runtimeAuthority,
        }))).toEqual({ ok: false, rejection: 'stale_expected_frontier' });
    });

    it('fails Account Voice observation closed without the current private voice_agent Run authority', async () => {
        const { viewer, session, key } = await fixture();
        const voiceSession = await db.session.create({ data: {
            accountId: viewer.id,
            tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
            metadata: '{}',
            encryptionMode: 'plain',
        } });
        await setAccountSessionFollow({ ...key, preferences: { notificationLevel: 'none', includeInVoice: true } });
        const observe = (runtimeAuthority?: Readonly<{
            executionRunId: string;
            occurrenceId: string;
            parentSessionId: string;
            intent: 'voice_agent';
            runtimeState: 'active_turn' | 'idle';
        }>) => inTx((tx) => observePendingAccountVoiceFollowInTx(tx, {
            accountId: viewer.id,
            voiceSessionId: voiceSession.id,
            authentication: defaultAuthentication,
            runtimeAuthority,
        }));
        const current = {
            executionRunId: 'voice-run-current',
            occurrenceId: 'voice-occurrence-current',
            parentSessionId: voiceSession.id,
            intent: 'voice_agent' as const,
            runtimeState: 'active_turn' as const,
        };

        await expect(observe()).resolves.toBeNull();
        await expect(observe({ ...current, parentSessionId: session.id })).resolves.toBeNull();

        const share = await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: voiceSession.id,
            createdByAccountId: viewer.id,
            accountId: (await db.account.create({ data: {
                publicKey: randomUUID(), encryptionMode: 'plain',
            } })).id,
            accessLevel: 'view',
        } });
        await expect(observe(current)).resolves.toBeNull();
        await db.sessionGrant.delete({ where: { principalKind: 'account', id: share.id } });
        const pending = await observe(current);
        expect(pending).toEqual([expect.objectContaining({
            sourceSessionId: session.id,
            voiceSessionId: voiceSession.id,
        })]);
        expect(await inTx((tx) => acknowledgeAccountVoiceFollowInTx(tx, {
            accountId: viewer.id,
            voiceSessionId: voiceSession.id,
            sourceSessionId: session.id,
            expected: null,
            observed: pending![0]!.observed,
            consumed: pending![0]!.observed,
            acceptance: { localInputId: 'ordinary-input', userMessageSeq: null },
            authentication: defaultAuthentication,
        }))).toEqual({ ok: false, rejection: 'forbidden' });
    });

    it('retains explicit suppression after access loss', async () => {
        const { key } = await fixture();
        await setAccountSessionFollow({ ...key, preferences: { notificationLevel: 'none', includeInVoice: true } });
        expect(await inTx(tx => resolveSessionFollowFactsInTx(tx, key))).toMatchObject({ follows: true, notificationLevel: 'none' });
        await db.sessionGrant.deleteMany({ where: { principalKind: 'account', sessionId: key.sessionId } });
        expect(await getAccountSessionFollow(key)).toEqual({ ok: false, error: 'session_not_found' });
        expect(await removeAccountSessionFollow(key)).toEqual({ ok: true, value: { changed: true } });
        expect(await inTx(tx => resolveSessionFollowFactsInTx(tx, key))).toMatchObject({ follows: false, notificationLevel: 'none' });
        expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: key } })).toMatchObject({ following: false, includeInVoice: false, voiceDeliveredFrontier: null });
    });


    it('keeps independent Discussion cursors neutral across Follow entry, refresh and re-entry', async () => {
        const { owner, viewer, key, session } = await fixture();
        const discussion = await createDiscussion({ sessionId: session.id, creatorAccountId: owner.id, messageSeq: 3 });
        const preferences = { notificationLevel: 'important' as const, includeInVoice: false };
        await setAccountSessionFollow({ ...key, preferences });
        expect(await db.discussionReadState.count({ where: { discussionId: discussion.id, accountId: viewer.id } })).toBe(0);
        await db.discussionReadState.create({ data: { discussionId: discussion.id, accountId: viewer.id, lastReadSeq: 1 } });
        await setAccountSessionFollow({ ...key, preferences: { ...preferences, notificationLevel: 'all_messages' } });
        await removeAccountSessionFollow(key);
        await db.discussion.update({ where: { id: discussion.id }, data: { messageSeq: 7 } });
        await setAccountSessionFollow({ ...key, preferences });
        expect(await db.discussionReadState.findUnique({
            where: { discussionId_accountId: { discussionId: discussion.id, accountId: viewer.id } },
        })).toMatchObject({ lastReadSeq: 1 });
    });


    it('leaves suppression and retained read frontiers untouched when default rules change', async () => {
        const { owner, viewer, key, session } = await fixture();
        const discussion = await createDiscussion({
            sessionId: session.id,
            creatorAccountId: owner.id,
            messageSeq: 8,
        });
        expect(await removeAccountSessionFollow(key)).toEqual({ ok: true, value: { changed: true } });
        const unreadSince = new Date(4_000);
        await db.accountSessionReadState.create({
            data: { ...key, lastViewedSessionSeq: 2, unreadSince },
        });
        await db.discussionReadState.create({
            data: { discussionId: discussion.id, accountId: viewer.id, lastReadSeq: 3 },
        });
        const changesBefore = await db.accountChange.count({
            where: { accountId: viewer.id, entityId: 'session-follows' },
        });

        expect(await setSessionAutoFollowPreferences({ accountId: viewer.id, preferences: {
            assigned: true, direct: true, team: true, group: true,
        } })).toMatchObject({ ok: true });

        expect(await db.accountSessionFollow.findUnique({
            where: { accountId_sessionId: key },
        })).toMatchObject({ following: false, followPolicy: null, includeInVoice: false });
        expect(await db.accountSessionReadState.findUnique({
            where: { accountId_sessionId: key },
        })).toMatchObject({ lastViewedSessionSeq: 2, unreadSince });
        expect(await db.discussionReadState.findUnique({
            where: { discussionId_accountId: { discussionId: discussion.id, accountId: viewer.id } },
        })).toMatchObject({ lastReadSeq: 3 });
        expect(await db.accountChange.count({
            where: { accountId: viewer.id, entityId: 'session-follows' },
        })).toBe(changesBefore);
    });

    it('rolls back the Follow write when the canonical tracking initializer cannot persist', async () => {
        const { key } = await fixture();
        await db.$executeRawUnsafe('CREATE TRIGGER fail_follow_tracking BEFORE INSERT ON "AccountSessionReadState" BEGIN SELECT RAISE(ABORT, \'tracking unavailable\'); END');
        try {
            await expect(setAccountSessionFollow({ ...key, preferences: { notificationLevel: 'important', includeInVoice: false } })).rejects.toThrow();
            expect(await db.accountSessionFollow.findUnique({ where: { accountId_sessionId: key } })).toBeNull();
            expect(await db.accountChange.count({ where: { accountId: key.accountId, entityId: 'session-follows' } })).toBe(0);
        } finally { await db.$executeRawUnsafe('DROP TRIGGER fail_follow_tracking'); }
    });

    it('reports the caller\'s own ownership so an owner without a stored row is not rendered as off', async () => {
        const { owner, viewer, session } = await fixture();
        expect(await getAccountSessionFollow({ accountId: owner.id, sessionId: session.id }))
            .toEqual({ ok: true, value: {
                follow: null,
                isSessionOwner: true,
                capabilities: { manageFollow: true },
                voiceInitialSnapshotPending: false,
            } });
        expect(await getAccountSessionFollow({ accountId: viewer.id, sessionId: session.id }))
            .toEqual({ ok: true, value: {
                follow: null,
                isSessionOwner: false,
                capabilities: { manageFollow: true },
                voiceInitialSnapshotPending: false,
            } });
    });

    it('uses the same coarse snapshot invalidation for defaults and relationship changes', async () => {
        const { viewer, key } = await fixture();
        const hintFor = async (accountId: string) => (await db.accountChange.findFirst({
            where: { accountId, entityId: 'session-follows' }, select: { hint: true },
        }))?.hint;
        const preferences = { assigned: false, direct: false, team: false, group: false };
        expect(await setSessionAutoFollowPreferences({ accountId: viewer.id, preferences })).toMatchObject({ ok: true });
        expect(await hintFor(viewer.id)).toEqual({ sessionFollows: true, full: true });

        // A Follow relationship change uses the same consumed snapshot refresh.
        await setAccountSessionFollow({ ...key, preferences: { notificationLevel: 'important', includeInVoice: false } });
        expect(await hintFor(viewer.id)).toEqual({ sessionFollows: true, full: true });

        // A later defaults edit cannot narrow the coalesced invalidation.
        expect(await setSessionAutoFollowPreferences({ accountId: viewer.id, preferences: { ...preferences, team: true } }))
            .toMatchObject({ ok: true });
        expect(await hintFor(viewer.id)).toEqual({ sessionFollows: true, full: true });
    });


    it('qualifies an explicit Follow through the canonical restricted Team access owner', async () => {
        const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
        const viewer = await db.account.create({ data: {
            publicKey: randomUUID(), encryptionMode: 'plain',
            sessionAutoFollowDirect: true, sessionAutoFollowTeam: true,
        } });
        const session = await db.session.create({
            data: { accountId: owner.id, tag: randomUUID(), metadata: '{}', encryptionMode: 'plain', seq: 10 },
        });
        const team = await db.team.create({ data: {
            name: `restricted-follow-${randomUUID()}`,
            authenticationPolicy: { v: 1, mode: 'restricted', accepted: [{ kind: 'home_method', methodId: 'github' }] },
        } });
        await db.teamMembership.create({ data: { teamId: team.id, accountId: viewer.id, role: 'member' } });
        await db.sessionGrant.create({ data: { principalKind: 'team',
            sessionId: session.id, teamId: team.id, accessLevel: 'view', effectiveAt: new Date(0),
        } });

        await expect(setAccountSessionFollow({
            accountId: viewer.id, sessionId: session.id, preferences: { notificationLevel: 'important', includeInVoice: false },
        })).resolves.toEqual({ ok: false, error: 'session_not_found' });
        expect(await db.accountSessionFollow.findUnique({ where: {
            accountId_sessionId: { accountId: viewer.id, sessionId: session.id },
        } })).toBeNull();

        // A separate direct-share arm qualifies the same Account even while the
        // restricted Team remains unqualified; this is the canonical access
        // composition, not a Team-policy bypass.
        await db.sessionGrant.create({ data: { principalKind: 'account',
            sessionId: session.id, createdByAccountId: owner.id, accountId: viewer.id, accessLevel: 'view',
        } });
        await expect(setAccountSessionFollow({
            accountId: viewer.id, sessionId: session.id, preferences: { notificationLevel: 'important', includeInVoice: false },
        })).resolves.toMatchObject({ ok: true });
        expect(await db.accountSessionFollow.findUnique({ where: {
            accountId_sessionId: { accountId: viewer.id, sessionId: session.id },
        } })).toMatchObject({ following: true, followPolicy: JSON.stringify({ preset: 'important' }) });
    });
});
