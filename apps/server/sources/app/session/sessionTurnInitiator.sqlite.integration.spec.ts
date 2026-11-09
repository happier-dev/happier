import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";
import { createPresentUserSessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication.testkit";
import * as lifecycleAdmission from "@/app/automations/automationSessionLifecycleAdmission";
import { applySessionTurnMutation, updateSessionAgentState, updateSessionMetadataEnvelopeTuple } from "./sessionWriteService";
import { createPlainSessionOwnerMetadataEnvelopeV1, encodeSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { setAccountSessionFollow } from './follow/accountFollowService';
import { parsePersistedPersonalFollowOnceV1 } from '@happier-dev/protocol/sessions/follow/accountFollow';

function holdPostCommitSessionReads() {
    const session = db.session;
    const read = session.findUnique;
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    // Prisma delegates are dynamic proxies. Restore the actual boundary method
    // directly; descriptor-based spy restoration can leave it undefined.
    session.findUnique = new Proxy(read, {
        apply(target, receiver, args) {
            const query: ReturnType<typeof read> = Reflect.apply(target, receiver, args);
            // Preserve the real fluent Prisma query and defer only its awaited
            // database result, rather than substituting a plain Promise.
            return new Proxy(query, {
                get(result, property) {
                    if (property === 'then') return (...callbacks: Parameters<typeof result.then>) =>
                        held.then(() => result.then(...callbacks));
                    return Reflect.get(result, property, result);
                },
            });
        },
    });
    return () => { release(); session.findUnique = read; };
}

describe("Host-stamped SessionTurn facts (SQLite integration)", () => {
    let harness: LightSqliteHarness;
    const authentication = createPresentUserSessionAccessAuthentication();

    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: "happier-turn-facts-", initAuth: false });
    }, 120_000);
    afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
    afterAll(async () => { if (harness) await harness.close(); });

    it('advances Session recency when a nonlatest turn settles after the latest turn', async () => {
        const suffix = randomUUID();
        const before = new Date('2020-01-01T00:00:00Z');
        const account = await db.account.create({ data: { publicKey: suffix, encryptionMode: 'plain' } });
        const session = await db.session.create({ data: {
            accountId: account.id, tag: suffix, metadata: '{}', encryptionMode: 'plain',
            updatedAt: before, lastActiveAt: before, latestTurnId: 'newer', latestTurnStatus: 'completed',
        } });
        await db.sessionTurn.createMany({ data: [
            { sessionId: session.id, turnId: 'older', status: 'in_progress', startedAt: 100n,
                updatedAt: 100n, lastMutationId: `begin-old-${suffix}` },
            { sessionId: session.id, turnId: 'newer', status: 'completed', startedAt: 200n,
                updatedAt: 300n, terminalAt: 300n, lastMutationId: `end-new-${suffix}` },
        ] });
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: {
            v: 1, sessionId: session.id, turnId: 'older', action: 'complete',
            mutationId: `late-end-${suffix}`, observedAt: 400,
        } })).toMatchObject({ ok: true, didApply: true });
        const current = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        expect(current.updatedAt.getTime()).toBeGreaterThan(before.getTime());
        expect(current).toMatchObject({ latestTurnId: 'newer', latestTurnStatus: 'completed', lastActiveAt: before });
        expect(await db.sessionTurn.findUniqueOrThrow({ where: {
            sessionId_turnId: { sessionId: session.id, turnId: 'older' },
        } })).toMatchObject({ status: 'completed', terminalAt: 400n });
    });

    it('settles a yielded question as waiting without a finished or stopped occurrence', async () => {
        const suffix = randomUUID();
        const account = await db.account.create({ data: { publicKey: suffix, encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: suffix, metadata: '{}', encryptionMode: 'plain' } });
        const turnId = `question-${suffix}`;
        const base = { v: 1, sessionId: session.id, turnId };
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication,
            mutation: { ...base, action: 'begin', mutationId: `begin-${suffix}`, observedAt: 100 } }))
            .toMatchObject({ ok: true, didApply: true });
        const waiting = { ...base, action: 'wait', mutationId: `wait-${suffix}`, observedAt: 200 };
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: waiting }))
            .toMatchObject({ ok: true, didApply: true });
        expect(await db.sessionTurn.findUniqueOrThrow({ where: { sessionId_turnId: { sessionId: session.id, turnId } } }))
            .toMatchObject({ status: 'waiting', terminalAt: 200n, lastRuntimeIssueJson: null });
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } }))
            .toMatchObject({ latestTurnStatus: 'waiting', thinking: false, latestReadyEventSeq: null });
        expect(await db.automationRun.count({ where: { accountId: account.id } })).toBe(0);
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication,
            mutation: { ...base, action: 'cancel', mutationId: `late-cancel-${suffix}`, observedAt: 210 } }))
            .toMatchObject({ ok: true, didApply: false });
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication,
            mutation: { ...base, action: 'end_session', mutationId: `host-exit-${suffix}`, observedAt: 220 } }))
            .toMatchObject({ ok: true, didApply: false, latestTurnStatus: 'waiting' });
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication,
            mutation: { ...base, turnId: `answer-${suffix}`, action: 'begin', mutationId: `answer-${suffix}`, observedAt: 300 } }))
            .toMatchObject({ ok: true, didApply: true });
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } }))
            .toMatchObject({ latestTurnStatus: 'in_progress', thinking: true });
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication,
            mutation: { ...base, turnId: `answer-${suffix}`, action: 'wait', mutationId: `wait-again-${suffix}`, observedAt: 350 } }))
            .toMatchObject({ ok: true, didApply: true, latestTurnStatus: 'waiting' });
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication,
            mutation: { ...base, turnId: `answer-${suffix}`, action: 'cancel', reason: 'explicit_stop', mutationId: `stop-${suffix}`, observedAt: 400 } }))
            .toMatchObject({ ok: true, didApply: true, latestTurnStatus: 'cancelled' });
    });

    it.each([0, 1])('accepts the first committed needs-you one-shot into Inbox without enrolling ongoing Follow or running a Habit (layout %s)', async layout => {
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED', 'true');
        const suffix = randomUUID();
        const account = await db.account.create({ data: { publicKey: suffix, encryptionMode: 'plain' } });
        const ownerMetadata = createPlainSessionOwnerMetadataEnvelopeV1({ v: 1 });
        const session = await db.session.create({ data: { accountId: account.id, tag: suffix, metadata: '{}', encryptionMode: 'plain', seq: 1,
            metadataLayoutVersion: layout, ownerMetadata: layout === 1 ? encodeSessionOwnerMetadataEnvelopeV1(ownerMetadata) : null } });
        const turnId = `turn-${suffix}`;
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: {
            v: 1, sessionId: session.id, turnId, action: 'begin', mutationId: `begin-${suffix}`, observedAt: 100,
        } })).toMatchObject({ ok: true, didApply: true });
        expect(await setAccountSessionFollow({ accountId: account.id, sessionId: session.id, authentication,
            preferences: { once: { kind: 'first_needs_you' } },
        })).toMatchObject({ ok: true });
        const where = { accountId_sessionId: { accountId: account.id, sessionId: session.id } };
        const before = await db.accountSessionFollow.findUniqueOrThrow({ where });
        const requestId = `request-${suffix}`;
        // Delay the real database boundary used by the post-commit sender, not
        // the transaction's Session delegate. Inbox acceptance cannot depend on it.
        const releasePostCommitRead = holdPostCommitSessionReads();
        try {
          const agentStateCiphertext = JSON.stringify({ requests: { [requestId]: {
                kind: 'user_action', tool: 'AskUserQuestion', arguments: {}, createdAt: 150,
            } } });
          const occurrences = [{
                sourceTurnId: turnId, requestId, requestKind: 'user_action', occurredAt: 150,
            }] as const;
          const writeTuple = (expectedVersion: number, ciphertext: string, pendingUserActionRequestCount: number) =>
            updateSessionMetadataEnvelopeTuple({ actorUserId: account.id, sessionId: session.id,
                mode: 'owner', metadataLayoutVersion: 1, expectedOwnerMetadata: ownerMetadata, ownerMetadata,
                sharedMetadata: { ciphertext: '{"v":1}', expectedVersion }, agentState: { ciphertext, expectedVersion },
                activitySummaryV1: { pendingPermissionRequestCount: 0, pendingUserActionRequestCount,
                    pendingRequestNewestCreatedAt: pendingUserActionRequestCount ? 150 : null,
                    ...(pendingUserActionRequestCount ? { newUserActionRequiredOccurrences: [...occurrences] } : {}) },
            });
          expect(await (layout === 0 ? updateSessionAgentState({ actorUserId: account.id, sessionId: session.id,
            expectedVersion: 0, agentStateCiphertext, pendingUserActionRequestCount: 1, userActionRequiredOccurrences: occurrences,
          }) : writeTuple(0, agentStateCiphertext, 1))).toMatchObject({ ok: true });
            const row = await db.accountSessionFollow.findUniqueOrThrow({ where });
            expect(parsePersistedPersonalFollowOnceV1(row.notifyOnce)).toMatchObject({ state: 'fulfilled', occurrence: {
                event: 'user_action_required', turnId, requestId, agentStateVersion: 1,
            } });
            expect(row).toMatchObject({ following: before.following, hasPersistentFollow: before.hasPersistentFollow,
                followPolicy: before.followPolicy, includeInVoice: before.includeInVoice,
                voiceDeliveredFrontier: before.voiceDeliveredFrontier });
            expect(await (layout === 0 ? updateSessionAgentState({ actorUserId: account.id, sessionId: session.id,
                expectedVersion: 1, agentStateCiphertext: '{}', pendingUserActionRequestCount: 0,
            }) : writeTuple(1, '{}', 0))).toMatchObject({ ok: true });
            expect(parsePersistedPersonalFollowOnceV1((await db.accountSessionFollow.findUniqueOrThrow({ where })).notifyOnce))
                .toMatchObject({ state: 'fulfilled', occurrence: { requestId } });
        } finally {
            releasePostCommitRead();
        }
    });

    it('accepts a current-turn successful completion without guessing an assistant message or the next turn', async () => {
        vi.stubEnv('HAPPIER_FEATURE_SESSIONS_FOLLOWING__ENABLED', 'true');
        const suffix = randomUUID();
        const account = await db.account.create({ data: { publicKey: suffix, encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: suffix, metadata: '{}', encryptionMode: 'plain' } });
        const turnId = `once-success-${suffix}`;
        expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: {
            v: 1, sessionId: session.id, turnId, action: 'begin', mutationId: `begin-${suffix}`, observedAt: 100,
        } })).toMatchObject({ ok: true, didApply: true });
        await setAccountSessionFollow({ accountId: account.id, sessionId: session.id, authentication,
            preferences: { once: { kind: 'turn_finished', sourceTurnId: turnId } } });
        // The committed Inbox effect must survive a delayed notification
        // transport, including a successful turn with no transcript output.
        const releasePostCommitRead = holdPostCommitSessionReads();
        try {
            expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: {
                v: 1, sessionId: session.id, turnId, action: 'complete', mutationId: `complete-${suffix}`, observedAt: 200,
            } })).toMatchObject({ ok: true, didApply: true });
            const row = await db.accountSessionFollow.findUniqueOrThrow({ where: { accountId_sessionId: {
                accountId: account.id, sessionId: session.id,
            } } });
            expect(parsePersistedPersonalFollowOnceV1(row.notifyOnce)).toMatchObject({ state: 'fulfilled', occurrence: { event: 'ready', turnId } });
            expect(row).toMatchObject({ following: false, hasPersistentFollow: false, includeInVoice: false });
        } finally {
            releasePostCommitRead();
        }
        expect(await db.sessionMessage.count({ where: { sessionId: session.id } })).toBe(0);
    });

    it.each(["user", "agent_session", "host", "workflow"] as const)(
        "persists %s facts unchanged and exposes them to both lifecycle admissions",
        async (initiator) => {
            const suffix = randomUUID();
            const account = await db.account.create({ data: { publicKey: suffix, encryptionMode: "plain" } });
            const session = await db.session.create({ data: { accountId: account.id, tag: suffix, metadata: "{}", encryptionMode: "plain" } });
            const turnId = `turn-${suffix}`;
            const facts = { initiator, workDepth: 29,
                ...(initiator === "workflow" ? { workflowInvocation: { runId: `run-${suffix}`, invocationRecordId: `invocation-${suffix}` } } : {}) };
            const begin = { v: 1, sessionId: session.id, turnId, agentTurnId: `native-${suffix}`, action: "begin", mutationId: `begin-${suffix}`, observedAt: 100, ...facts };
            expect(await applySessionTurnMutation({ actorUserId: account.id, authentication, mutation: begin }))
                .toMatchObject({ ok: true, didApply: true });
            const stored = await db.sessionTurn.findUniqueOrThrow({ where: { sessionId_turnId: { sessionId: session.id, turnId } } });
            expect(stored).toMatchObject({ initiator, workDepth: 29 });
            expect(stored.workflowInvocationJson === null ? undefined : JSON.parse(stored.workflowInvocationJson))
                .toEqual(facts.workflowInvocation);

            expect(await applySessionTurnMutation({ actorUserId: account.id, authentication,
                mutation: { ...begin, mutationId: `rejoin-${suffix}`, observedAt: 110,
                    initiator: "user", workDepth: 0, workflowInvocation: undefined } }))
                .toMatchObject({ ok: true, didApply: true });
            expect(await db.sessionTurn.findUniqueOrThrow({ where: { id: stored.id } }))
                .toMatchObject({ initiator, workDepth: 29, workflowInvocationJson: stored.workflowInvocationJson });

            // Observation only: the spy calls the real admission owner, including
            // its real DB reads/writes. No internal domain behavior is replaced.
            const admission = vi.spyOn(lifecycleAdmission, "admitSessionLifecycleAutomationRunsTx");
            expect(await updateSessionAgentState({ actorUserId: account.id, sessionId: session.id,
                expectedVersion: 0, agentStateCiphertext: "{}", userActionRequiredOccurrences: [{
                    sourceTurnId: turnId, requestId: `request-${suffix}`, requestKind: "permission", occurredAt: 150,
                }] })).toMatchObject({ ok: true });
            expect(admission.mock.calls.find(([input]) => input.occurrence.event === "userActionRequired")?.[0])
                .toMatchObject({ sourceTurnFacts: facts });
            expect(await applySessionTurnMutation({ actorUserId: account.id, authentication,
                mutation: { v: 1, sessionId: session.id, turnId, action: "complete", mutationId: `complete-${suffix}`, observedAt: 200 } }))
                .toMatchObject({ ok: true, didApply: true });
            expect(admission.mock.calls.find(([input]) => input.occurrence.event === "parentTurnCompleted")?.[0])
                .toMatchObject({ sourceTurnFacts: facts });
            expect(await db.sessionTurn.findUniqueOrThrow({ where: { id: stored.id } }))
                .toMatchObject({ initiator, workDepth: 29, workflowInvocationJson: stored.workflowInvocationJson });
        },
    );

    it.each(['begin', 'complete'] as const)('keeps a failed turn terminal after newer matching native %s evidence while allowing a new turn', async action => {
        const suffix = randomUUID();
        const account = await db.account.create({ data: { publicKey: suffix, encryptionMode: 'plain' } });
        const session = await db.session.create({ data: { accountId: account.id, tag: suffix, metadata: '{}', encryptionMode: 'plain' } });
        const turnId = `failed-${suffix}`;
        const base = { v: 1, sessionId: session.id, turnId, agentId: 'codex', agentTurnId: `native-${suffix}` } as const;
        const apply = (mutation: unknown) => applySessionTurnMutation({ actorUserId: account.id, authentication, mutation });
        expect(await apply({ ...base, action: 'begin', mutationId: `begin-${suffix}`, observedAt: 100 }))
            .toMatchObject({ ok: true, didApply: true });
        expect(await apply({ ...base, action: 'fail', mutationId: `fail-${suffix}`, observedAt: 200,
            issue: { v: 1, scope: 'primary_session', status: 'failed', code: 'test_failure', source: 'unknown', occurredAt: 200,
                agentId: base.agentId, agentTurnId: base.agentTurnId } }))
            .toMatchObject({ ok: true, didApply: true });
        const where = { sessionId_turnId: { sessionId: session.id, turnId } };
        const failedTurn = await db.sessionTurn.findUniqueOrThrow({ where });
        const failedSession = await db.session.findUniqueOrThrow({ where: { id: session.id } });
        // MMD-58: matching ids and a later timestamp are not native recovery authority.
        const late = { ...base, action, mutationId: `late-${suffix}`, observedAt: 300 };
        const result = await apply(late);
        expect(result).toMatchObject({ ok: true, didApply: false, reason: 'terminal-turn', latestTurnStatus: 'failed',
            receipt: { mutationId: late.mutationId, turnId, action, decision: 'stale-terminal' } });
        expect(await db.sessionTurn.findUniqueOrThrow({ where })).toEqual(failedTurn);
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } })).toEqual(failedSession);
        expect(await apply(late)).toMatchObject({ ok: true, didApply: false, reason: 'duplicate-mutation', receipt: result.ok ? result.receipt : undefined });
        expect(await db.sessionTurnMutationReceipt.count({ where: { sessionId: session.id, mutationId: late.mutationId } })).toBe(1);

        const next = { ...base, turnId: `next-${suffix}`, agentTurnId: `next-native-${suffix}` };
        expect(await apply({ ...next, action: 'begin', mutationId: `next-begin-${suffix}`, observedAt: 400 }))
            .toMatchObject({ ok: true, didApply: true, latestTurnId: next.turnId, latestTurnStatus: 'in_progress', lastRuntimeIssue: null });
        expect(await apply({ ...next, action: 'complete', mutationId: `next-complete-${suffix}`, observedAt: 500 }))
            .toMatchObject({ ok: true, didApply: true, latestTurnId: next.turnId, latestTurnStatus: 'completed', lastRuntimeIssue: null });
        expect(await db.sessionTurn.findUniqueOrThrow({ where })).toEqual(failedTurn);
        expect(await db.session.findUniqueOrThrow({ where: { id: session.id } }))
            .toMatchObject({ latestTurnId: next.turnId, latestTurnStatus: 'completed', thinking: false, lastRuntimeIssue: null });
    });
});
