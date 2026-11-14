import { applySessionTurnMutation } from '@/app/session/sessionWriteService';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { UsageEventIngestRequestSchema } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { db } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { deleteNativeUsageHistory, recordUsageEvent, recordTeamCredentialExternalTerminalUsageEventInTx } from '@/app/usage/usageWriteService';
import { createUsageEventRetentionRule } from '@/app/retention/rules/usageEventRetentionRule';
import { readRetentionPolicyFromEnv } from '@/app/retention/config/readRetentionPolicyFromEnv';
import { evaluateTeamCredentialUsageAdmissionLimitsInTx, projectTeamCredentialUsageLimitsInTx } from './teamCredentialUsageLimits';
import { parseUsageLimitRows } from './teamCredentialUsageLimitEvaluation';
import { refreshTeamCredentialUsageCountersInTx } from './teamCredentialUsageCounters';
import { admitTeamCredentialUsageInTx } from './teamCredentialUsageAdmission';

async function fixture() {
    const [custodian, member, other] = await Promise.all(Array.from({ length: 3 }, () => db.account.create({ data: { encryptionMode: 'plain' } })));
    if (!custodian || !member || !other) throw new Error('Missing fixture Account');
    const team = await db.team.create({ data: { name: 'Counter contract' } });
    const resource = await db.teamCredentialResource.create({ data: {
        teamId: team.id, custodianAccountId: custodian.id, displayName: 'Counter provider',
        sourceBindingJson: '{}', disclosureCeiling: 'brokered_only', sessionUsePolicy: 'team_context_required',
        allMembersDeliveryMode: 'brokered',
    } });
    const session = await db.session.create({ data: { accountId: member.id, tag: randomUUID(), encryptionMode: 'plain', metadata: '{}' } });
    const now = new Date('2026-09-07T12:00:00Z');
    const read = (actorAccountId = member.id) => inTx(tx => evaluateTeamCredentialUsageAdmissionLimitsInTx(tx, {
        resourceId: resource.id, actorAccountId, now,
    }), { isolationLevel: 'ReadCommitted' });
    const admission = await inTx(tx => admitTeamCredentialUsageInTx(tx, {
        storageAccountId: member.id, sessionId: session.id, turnId: 'turn', observedAt: now,
        requestId: randomUUID(), modelId: 'model', usageRoute: 'agent_runtime_session_turn',
        authority: { kind: 'teamCredentialAdmission', requestingAccountId: member.id, resourceId: resource.id,
            externalApiKeyId: null, sourceCredentialId: null, workerMachineId: null,
            brokerMachineId: 'broker', deliveryMode: 'brokered', executionRunId: null },
    }), { isolationLevel: 'ReadCommitted' });
    expect(admission).toMatchObject({ ok: true, created: true });
    const limit = await db.teamCredentialUsageLimit.create({ data: {
        resourceId: resource.id, subjectKind: 'resource', subjectId: '', period: 'month', metric: 'total_tokens',
        maximum: '10000', createdAt: new Date('2026-09-01T00:00:00Z'),
    } });
    const observation = (externalKey: string, observedAt: Date, total: number) => UsageEventIngestRequestSchema.parse({
        sessionId: session.id, turnId: 'turn', externalKey, observedAt: observedAt.getTime(), agentId: 'codex',
        source: 'runtime', scope: 'session_cumulative', isCumulative: true,
        tokens: { input: total, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total },
        cost: { reportedUsd: total / 100, estimatedUsd: null, currency: 'USD' },
    });
    return { custodian, member, other, team, resource, session, now, limit, read, observation };
}

export function defineTeamCredentialUsageCounterContract(options: Readonly<{ concurrent: boolean }>) {
    it('isolates custodian, resource, limit, member and projection-kind namespaces at scale', async () => {
        const f = await fixture();
        const memberLimit = await db.teamCredentialUsageLimit.create({ data: {
            resourceId: f.resource.id, subjectKind: 'each_member', subjectId: '', period: 'day', metric: 'total_tokens',
            maximum: '10000', createdAt: f.limit.createdAt,
        } });
        const second = await fixture();
        await db.usageEvent.createMany({ data: Array.from({ length: 1000 }, (_, index) => ({
            accountId: index % 2 === 0 ? f.member.id : f.other.id, observedAt: f.now, agentId: 'test',
            source: 'runtime', scope: 'turn_delta', totalTokens: 1,
            teamCredentialResourceId: f.resource.id,
            teamCredentialActorAccountId: index % 2 === 0 ? f.member.id : f.other.id,
            credentialDeliveryMode: 'brokered',
        })) });
        await expect(f.read()).resolves.toMatchObject({ ok: true, applied: [
            { limitId: f.limit.id, recorded: 1000 }, { limitId: memberLimit.id, recorded: 500 },
        ] });
        await expect(f.read(f.other.id)).resolves.toMatchObject({ ok: true, applied: [
            { limitId: f.limit.id, recorded: 1000 }, { limitId: memberLimit.id, recorded: 500 },
        ] });
        await expect(second.read()).resolves.toMatchObject({ ok: true, applied: [{ limitId: second.limit.id, recorded: 0 }] });
        let sourceRows = 0;
        let counterRows = 0;
        await inTx(async tx => {
            const observed = new Proxy(tx, { get(target, property, receiver) {
                if (property !== 'usageEvent' && property !== 'usageAccountingProjection') return Reflect.get(target, property, receiver);
                const delegate = target[property];
                return new Proxy(delegate, { get(model, method, modelReceiver) {
                    const operation = Reflect.get(model, method, modelReceiver);
                    if (method !== 'findMany' || typeof operation !== 'function') return operation;
                    return async (...args: readonly unknown[]) => {
                        const rows = await Reflect.apply(operation, model, args) as readonly unknown[];
                        if (property === 'usageEvent') sourceRows += rows.length;
                        else counterRows += rows.length;
                        return rows;
                    };
                } });
            } });
            expect(await evaluateTeamCredentialUsageAdmissionLimitsInTx(observed, {
                resourceId: f.resource.id, actorAccountId: f.member.id, now: f.now,
            })).toMatchObject({ ok: true });
        }, { isolationLevel: 'ReadCommitted' });
        expect(sourceRows).toBe(0);
        expect(counterRows).toBe(2);
        const rows = await db.usageAccountingProjection.findMany({ where: { accountId: f.custodian.id, kind: 'teamSpend' } });
        expect(rows).toHaveLength(3);
        // Accounting row locks must not advance the credential's public lifecycle.
        expect(await db.teamCredentialResource.findUnique({ where: { id: f.resource.id } })).toEqual(f.resource);
        const privateRow = await db.usageAccountingProjection.create({ data: {
            recordKey: randomUUID().replaceAll('-', '').padEnd(64, '0'), accountId: f.custodian.id,
            kind: 'actSummary8', observedAtMs: 0n, validFromMs: 0n, payload: 'private Account analytics',
        } });
        await expect(f.read()).resolves.toMatchObject({ ok: true, applied: [{ recorded: 1000 }, { recorded: 500 }] });
        expect(await db.usageAccountingProjection.findUnique({ where: { recordKey: privateRow.recordKey } })).toEqual(privateRow);

    });

    it('leaves unrelated old and future periods untouched when recording a current terminal observation', async () => {
        const f = await fixture();
        const day = await db.teamCredentialUsageLimit.create({ data: {
            resourceId: f.resource.id, subjectKind: 'resource', subjectId: '', period: 'day', metric: 'total_tokens',
            maximum: '10000', createdAt: f.limit.createdAt,
        } });
        await db.usageEvent.create({ data: { accountId: f.member.id, observedAt: new Date('2026-09-02T12:00:00Z'),
            agentId: 'test', source: 'runtime', scope: 'turn_delta', totalTokens: 2,
            teamCredentialResourceId: f.resource.id, teamCredentialActorAccountId: f.member.id, credentialDeliveryMode: 'brokered' } });
        for (const date of ['2026-09-02T12:00:00Z', '2026-09-10T12:00:00Z']) {
            await inTx(tx => evaluateTeamCredentialUsageAdmissionLimitsInTx(tx, {
                resourceId: f.resource.id, actorAccountId: f.member.id, now: new Date(date),
            }), { isolationLevel: 'ReadCommitted' });
        }
        await f.read();
        const unrelated = await db.usageAccountingProjection.findMany({ where: {
            accountId: f.custodian.id, kind: 'teamSpend',
            validFromMs: { in: [BigInt(Date.parse('2026-09-02T00:00:00Z')), BigInt(Date.parse('2026-09-10T00:00:00Z'))] },
        } });
        expect(unrelated).toHaveLength(2);
        const requestId = randomUUID();
        const admission = await db.usageEvent.create({ data: {
            accountId: f.member.id, observedAt: f.now, externalKey: requestId,
            agentId: 'test', source: 'team_credential_admission', scope: 'turn_delta', requestCount: 1,
            teamCredentialActorAccountId: f.member.id, teamCredentialResourceId: f.resource.id,
            teamCredentialExternalApiKeyId: 'external-key', brokerMachineId: 'broker', credentialDeliveryMode: 'external_api',
        } });
        const writtenKeys: string[] = [];
        await inTx(async tx => {
            const observed = new Proxy(tx, { get(target, property, receiver) {
                if (property !== 'usageAccountingProjection') return Reflect.get(target, property, receiver);
                return new Proxy(target.usageAccountingProjection, { get(model, method, modelReceiver) {
                    const operation = Reflect.get(model, method, modelReceiver);
                    if (method !== 'update' || typeof operation !== 'function') return operation;
                    return async (args: Parameters<typeof model.update>[0]) => {
                        if (args.where.recordKey) writtenKeys.push(args.where.recordKey);
                        return Reflect.apply(operation, model, [args]);
                    };
                } });
            } });
            await recordTeamCredentialExternalTerminalUsageEventInTx(observed, {
                accountId: f.member.id, requestId, completedAt: f.now, outcome: 'succeeded', measurement: 'reported',
                modelId: null, tokens: { input: 20, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 20 },
                cost: null, authority: { kind: 'teamCredentialExternalTerminal', admissionUsageEventId: admission.id,
                    requestingAccountId: f.member.id, resourceId: f.resource.id, brokerMachineId: 'broker' },
            });
        }, { isolationLevel: 'ReadCommitted' });
        await expect(f.read()).resolves.toMatchObject({ ok: true, applied: [
            { limitId: f.limit.id, recorded: 22 }, { limitId: day.id, recorded: 20 },
        ] });
        for (const row of unrelated) expect(writtenKeys).not.toContain(row.recordKey);
    });

    it('refreshes late cumulative corrections and retained-source deletions through their real producers', async () => {
        const f = await fixture();
        const day = await db.teamCredentialUsageLimit.create({ data: {
            resourceId: f.resource.id, subjectKind: 'resource', subjectId: '', period: 'day', metric: 'total_tokens',
            maximum: '10000', createdAt: f.limit.createdAt,
        } });
        const before = new Date('2026-09-06T10:00:00Z');
        expect(await recordUsageEvent(f.member.id, f.observation('earlier', before, 10))).toMatchObject({ ok: true });
        expect(await recordUsageEvent(f.member.id, f.observation('current', f.now, 30))).toMatchObject({ ok: true });
        await expect(f.read()).resolves.toMatchObject({ ok: true, applied: [
            { limitId: f.limit.id, recorded: 30 }, { limitId: day.id, recorded: 20 },
        ] });
        expect(await recordUsageEvent(f.member.id, f.observation('late-baseline', new Date('2026-09-06T11:00:00Z'), 25))).toMatchObject({ ok: true });
        await expect(f.read()).resolves.toMatchObject({ ok: true, applied: [
            { limitId: f.limit.id, recorded: 30 }, { limitId: day.id, recorded: 5 },
        ] });
        const base = readRetentionPolicyFromEnv({});
        await createUsageEventRetentionRule().run({ policy: { ...base, enabled: true,
            domains: { ...base.domains, usageEvents: { mode: 'delete_older_than', days: 1 } } },
            now: new Date('2026-09-08T13:00:00Z'), batchSize: 5000, maxDeletesPerRulePerRun: 5000, dryRun: false });
        await expect(f.read()).resolves.toMatchObject({ ok: true, applied: [
            { limitId: f.limit.id, recorded: 0 }, { limitId: day.id, recorded: 0 },
        ] });
        expect(await db.usageEvent.count({ where: { accountId: f.member.id } })).toBe(0);
    });

    it('keeps native settlement and deletion aligned with the canonical linked-Session fold', async () => {
        const f = await fixture();
        const machine = await db.machine.create({ data: { id: randomUUID(), accountId: f.member.id, metadata: '{}' } });
        const subject = { kind: 'native', machineId: machine.id,
            agent: { pluginId: 'happier.agent.codex', localId: 'codex' }, sourceRootKey: 'root',
            nativeSessionKey: 'session', linkedSessionId: f.session.id } as const;
        const request = UsageEventIngestRequestSchema.parse({
            ...f.observation('runtime-native', f.now, 10), scope: 'turn_delta', isCumulative: false,
            metadata: { accountingSubject: subject, usageAccounting: { path: 'runtime', status: 'available', inferenceId: 'inference' } },
        });
        expect(await recordUsageEvent(f.member.id, request)).toMatchObject({ ok: true });
        await expect(f.read()).resolves.toMatchObject({ ok: true, applied: [{ recorded: 10 }] });
        const native = UsageEventIngestRequestSchema.parse({ ...request, sessionId: undefined, subject, source: 'codex-native', externalKey: 'native',
            accounting: { status: 'available', inferenceKey: 'inference' },
            tokens: { ...request.tokens, input: 20, total: 20 }, metadata: undefined });
        expect(await recordUsageEvent(f.member.id, native)).toMatchObject({ ok: true });
        const canonical = () => inTx(tx => projectTeamCredentialUsageLimitsInTx(tx, { resourceId: f.resource.id, actorAccountId: f.member.id, now: f.now, limits: parseUsageLimitRows([f.limit]) }));
        expect(await f.read()).toMatchObject(await canonical());
        expect(await recordUsageEvent(f.member.id, { ...native, tokens: { ...native.tokens, input: 27, total: 27 } })).toMatchObject({ ok: true });
        expect(await f.read()).toMatchObject(await canonical());
        expect(await deleteNativeUsageHistory(f.member.id, { machineId: machine.id, sourceRootKey: 'root' })).toMatchObject({ ok: true, deletedEventCount: 1 });
        await expect(f.read()).resolves.toMatchObject({ ok: true, applied: [{ recorded: 10 }] });
    });

    it('refreshes an existing turn when its first immutable Group attribution is admitted', async () => {
        const f = await fixture();
        const membership = await db.teamMembership.create({ data: { teamId: f.team.id, accountId: f.member.id, role: 'member' } });
        const group = await db.teamGroup.create({ data: { teamId: f.team.id, name: 'Budget group' } });
        await db.teamGroupMembership.create({ data: { teamId: f.team.id, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true } });
        const limit = await db.teamCredentialUsageLimit.create({ data: {
            resourceId: f.resource.id, subjectKind: 'team_group', subjectId: group.id,
            period: 'month', metric: 'total_tokens', maximum: '10000', createdAt: f.limit.createdAt,
        } });
        expect(await recordUsageEvent(f.member.id, { ...f.observation('before-group-admission', f.now, 20), scope: 'turn_delta', isCumulative: false })).toMatchObject({ ok: true });
        await expect(f.read()).resolves.toMatchObject({ ok: true, applied: [{ recorded: 20 }, { limitId: limit.id, recorded: 0 }] });
        const admit = (tx: Tx) => admitTeamCredentialUsageInTx(tx, {
            storageAccountId: f.member.id, sessionId: f.session.id, turnId: 'turn', observedAt: f.now,
            requestId: randomUUID(), modelId: 'model', usageRoute: 'agent_runtime_session_turn',
            authority: { kind: 'teamCredentialAdmission', requestingAccountId: f.member.id, resourceId: f.resource.id,
                externalApiKeyId: null, sourceCredentialId: null, workerMachineId: null,
                brokerMachineId: 'broker', deliveryMode: 'brokered', executionRunId: null },
        });
        expect(await inTx(admit, { isolationLevel: 'ReadCommitted' })).toMatchObject({ ok: true, created: true });
        await expect(f.read()).resolves.toMatchObject({ ok: true, applied: [{ recorded: 20 }, { limitId: limit.id, recorded: 20 }] });
        let loadedHistoryRows = 0;
        const repeated = await inTx(async tx => {
            const observed = new Proxy(tx, { get(target, property, receiver) {
                if (property !== 'usageEvent') return Reflect.get(target, property, receiver);
                return new Proxy(target.usageEvent, { get(model, method, modelReceiver) {
                    const operation = Reflect.get(model, method, modelReceiver);
                    if (method !== 'findMany' || typeof operation !== 'function') return operation;
                    return async (...args: readonly unknown[]) => {
                        const rows = await Reflect.apply(operation, model, args) as readonly unknown[];
                        loadedHistoryRows += rows.length;
                        return rows;
                    };
                } });
            } });
            return admit(observed);
        }, { isolationLevel: 'ReadCommitted' });
        expect(repeated).toMatchObject({ ok: true, created: true });
        expect(loadedHistoryRows).toBe(0);
        await expect(f.read()).resolves.toMatchObject({ ok: true, applied: [{ recorded: 20 }, { recorded: 20 }] });
    });

    it('reconstructs the pre-limit turn exclusion when its first begin arrives after usage', async () => {
        const f = await fixture();
        expect(await recordUsageEvent(f.member.id, { ...f.observation('before-turn-begin', f.now, 10),
            scope: 'turn_delta', isCumulative: false })).toMatchObject({ ok: true });
        await expect(f.read()).resolves.toMatchObject({ ok: true, applied: [{ recorded: 10 }] });
        expect(await applySessionTurnMutation({ actorUserId: f.member.id,
            authentication: createPresentUserSessionAccessAuthentication(), mutation: {
                v: 1, sessionId: f.session.id, turnId: 'turn', action: 'begin', mutationId: randomUUID(),
                observedAt: new Date('2026-08-31T23:59:59Z').getTime(),
            } })).toMatchObject({ ok: true, didApply: true });
        const canonical = await inTx(tx => projectTeamCredentialUsageLimitsInTx(tx, {
            resourceId: f.resource.id, actorAccountId: f.member.id, now: f.now, limits: parseUsageLimitRows([f.limit]),
        }));
        expect(canonical).toMatchObject({ ok: true, applied: [{ recorded: 0 }] });
        expect(await f.read()).toMatchObject(canonical);
    });

    it('uses the entire recorded period, including a later same-period observation', async () => {
        const f = await fixture();
        const future = new Date('2026-09-07T18:00:00Z');
        expect(await recordUsageEvent(f.member.id, f.observation('future-recorded', future, 9))).toMatchObject({ ok: true });
        await expect(f.read()).resolves.toMatchObject({ ok: true, applied: [{ limitId: f.limit.id, recorded: 9 }] });
    });

    if (options.concurrent) it('serializes a first reconstruction with a concurrent correction without leaving stale spend', async () => {
        const f = await fixture();
        const event = await db.usageEvent.create({ data: { accountId: f.member.id, observedAt: f.now,
            agentId: 'test', source: 'runtime', scope: 'turn_delta', totalTokens: 10,
            teamCredentialResourceId: f.resource.id, teamCredentialActorAccountId: f.member.id, credentialDeliveryMode: 'brokered' } });
        // Remove only this fixture's derived counter to exercise retained-data initialization.
        await db.usageAccountingProjection.deleteMany({ where: { accountId: f.custodian.id, kind: 'teamSpend' } });
        let sourceCaptured!: () => void;
        let continueReader!: () => void;
        const captured = new Promise<void>(resolve => { sourceCaptured = resolve; });
        const resume = new Promise<void>(resolve => { continueReader = resolve; });
        const first = inTx(async tx => {
            let paused = false;
            const observed = new Proxy(tx, { get(target, property, receiver) {
                if (property !== 'usageEvent') return Reflect.get(target, property, receiver);
                return new Proxy(target.usageEvent, { get(model, method, modelReceiver) {
                    const operation = Reflect.get(model, method, modelReceiver);
                    if (method !== 'findMany' || typeof operation !== 'function') return operation;
                    return async (...args: readonly unknown[]) => {
                        const rows: unknown = await Reflect.apply(operation, model, args);
                        if (!paused) { paused = true; sourceCaptured(); await resume; }
                        return rows;
                    };
                } });
            } });
            return evaluateTeamCredentialUsageAdmissionLimitsInTx(observed, { resourceId: f.resource.id, actorAccountId: f.member.id, now: f.now });
        }, { isolationLevel: 'ReadCommitted' });
        await captured;
        let corrected!: () => void;
        const changed = new Promise<void>(resolve => { corrected = resolve; });
        const correction = inTx(async tx => {
            await tx.usageEvent.update({ where: { id: event.id }, data: { totalTokens: 27 } });
            corrected();
            await refreshTeamCredentialUsageCountersInTx(tx, { resourceIds: [f.resource.id], changedObservedAts: [f.now] });
        }, { isolationLevel: 'ReadCommitted' });
        await changed;
        continueReader();
        await first;
        await correction;
        await expect(f.read()).resolves.toMatchObject({ ok: true, applied: [{ limitId: f.limit.id, recorded: 27 }] });
        const canonical = await inTx(tx => projectTeamCredentialUsageLimitsInTx(tx, {
            resourceId: f.resource.id, actorAccountId: f.member.id, now: f.now, limits: parseUsageLimitRows([f.limit]),
        }));
        expect(await f.read()).toMatchObject(canonical);
        expect(await db.teamCredentialResource.findUnique({ where: { id: f.resource.id } })).toEqual(f.resource);
    });
}
