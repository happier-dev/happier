import { usageAccountingProjectionKey } from '@/app/usage/query/usageAccountingProjectionKey';
import { z } from 'zod/mini';
import { resolveDbSqlDialect } from '@/config/databaseProvider';
import { getDbProviderFromEnv, prismaRuntime } from '@/storage/prisma';
import type { Tx } from '@/storage/inTx';
import { resolveUsageBucketBounds } from '@happier-dev/protocol/usage/usageCalendar';
import {
    evaluateResourcesFromDatabaseInTx, evaluateTeamCredentialUsageLimits, measureTeamCredentialUsageLimit,
    parseMaximum, parseUsageLimitRows, selectApplicableTeamCredentialUsageLimits,
    type TeamCredentialUsageLimitEvaluation, type TeamCredentialUsageLimitEvent,
    type TeamCredentialUsageLimitInputRow, type TeamCredentialUsageLimitRow,
} from './teamCredentialUsageLimitEvaluation';

const kind = 'teamSpend';
const payloadSchema = z.strictObject({
    limitId: z.string(),
    actorAccountId: z.string(),
    recorded: z.number(),
    measurementUnavailable: z.boolean(),
});

type TeamCredentialUsageCounterValue = z.infer<typeof payloadSchema>;
type TeamCredentialUsageCounterIdentity = Readonly<{
    resourceId: string;
    custodianAccountId: string;
    limitId: string;
    actorAccountId: string;
    bucketStartMs: number;
    bucketEndMs: number;
}>;

function teamCredentialUsageCounterKey(identity: TeamCredentialUsageCounterIdentity): string {
    return usageAccountingProjectionKey([kind, identity.custodianAccountId, identity.resourceId, identity.limitId, identity.actorAccountId, identity.bucketStartMs]);
}

async function readTeamCredentialUsageCountersInTx(tx: Tx,
    identities: readonly TeamCredentialUsageCounterIdentity[]): Promise<Map<string, TeamCredentialUsageCounterValue>> {
    if (identities.length === 0) return new Map();
    const rows = await tx.usageAccountingProjection.findMany({
        where: { accountId: { in: [...new Set(identities.map(identity => identity.custodianAccountId))] },
            recordKey: { in: identities.map(teamCredentialUsageCounterKey) }, kind },
        select: { recordKey: true, payload: true },
    });
    return new Map(rows.flatMap(row => row.payload === 'null' ? []
        : [[row.recordKey, payloadSchema.parse(JSON.parse(row.payload))] as const]));
}

/** Serialize reconstruction with source corrections on the existing resource row. */
async function lockResourcesInTx(tx: Tx, resourceIds: readonly string[]): Promise<void> {
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    const table = prismaRuntime.raw(dialect === 'mysql' ? '`TeamCredentialResource`' : '"TeamCredentialResource"');
    const id = prismaRuntime.raw(dialect === 'mysql' ? '`id`' : '"id"');
    const revision = prismaRuntime.raw(dialect === 'mysql' ? '`revision`' : '"revision"');
    for (const resourceId of [...new Set(resourceIds)].sort()) {
        await tx.$executeRaw(prismaRuntime.sql`UPDATE ${table} SET ${revision} = ${revision} WHERE ${id} = ${resourceId}`);
    }
}

/** The native upsert takes only this accounting row's ordinary write lock. */
async function lockTeamCredentialUsageCounterInTx(tx: Tx,
    identity: TeamCredentialUsageCounterIdentity, accountId: string): Promise<void> {
    const dialect = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres'));
    const quote = (name: string) => prismaRuntime.raw(dialect === 'mysql' ? '`' + name + '`' : '"' + name + '"');
    const keepPayload = dialect === 'mysql'
        ? prismaRuntime.sql`ON DUPLICATE KEY UPDATE ${quote('validUntilMs')} = VALUES(${quote('validUntilMs')})`
        : prismaRuntime.sql`ON CONFLICT (${quote('recordKey')}) DO UPDATE SET ${quote('validUntilMs')} = excluded.${quote('validUntilMs')}`;
    await tx.$executeRaw(prismaRuntime.sql`
        INSERT INTO ${quote('UsageAccountingProjection')}
            (${quote('recordKey')}, ${quote('accountId')}, ${quote('kind')}, ${quote('itemKey')}, ${quote('subjectHash')},
                ${quote('observedAtMs')}, ${quote('validFromMs')}, ${quote('validUntilMs')}, ${quote('payload')})
        VALUES (${teamCredentialUsageCounterKey(identity)}, ${accountId}, ${kind}, ${usageAccountingProjectionKey([identity.resourceId])}, ${usageAccountingProjectionKey([identity.limitId])},
            ${BigInt(identity.bucketStartMs)}, ${BigInt(identity.bucketStartMs)}, ${BigInt(identity.bucketEndMs)}, ${'null'})
        ${keepPayload}`);
}

async function writeTeamCredentialUsageCounterInTx(tx: Tx,
    identity: TeamCredentialUsageCounterIdentity, value: TeamCredentialUsageCounterValue): Promise<void> {
    await tx.usageAccountingProjection.update({
        where: { recordKey: teamCredentialUsageCounterKey(identity) },
        data: { payload: JSON.stringify(value) },
    });
}

/** Only already-consumed counters need producer refresh; a first read reconstructs its own period. */
async function listTeamCredentialUsageCountersInTx(tx: Tx, input: Readonly<{ resourceIds: readonly string[]; accountIds: readonly string[]; observedRange: { startMs: number; endMs: number } }>) {
    if (input.resourceIds.length === 0) return [];
    const rows = await tx.usageAccountingProjection.findMany({
        where: { validUntilMs: { gt: BigInt(input.observedRange.startMs) }, validFromMs: { lte: BigInt(input.observedRange.endMs) },
            accountId: { in: [...new Set(input.accountIds)] }, kind, itemKey: { in: [...new Set(input.resourceIds)].map(resourceId => usageAccountingProjectionKey([resourceId])) } },
        select: { recordKey: true, observedAtMs: true, validUntilMs: true, payload: true },
    });
    return rows.flatMap(row => row.payload === 'null' ? [] : [{
        ...payloadSchema.parse(JSON.parse(row.payload)),
        recordKey: row.recordKey,
        bucketStartMs: Number(row.observedAtMs),
        bucketEndMs: Number(row.validUntilMs),
    }]);
}

export async function deleteTeamCredentialUsageCountersInTx(tx: Tx, accountId: string, limitId: string): Promise<void> {
    await tx.usageAccountingProjection.deleteMany({ where: { accountId, kind, subjectHash: usageAccountingProjectionKey([limitId]) } });
}

export async function deleteTeamCredentialResourceUsageCountersInTx(tx: Tx, accountId: string, resourceId: string): Promise<void> {
    await tx.usageAccountingProjection.deleteMany({ where: {
        accountId, kind, itemKey: usageAccountingProjectionKey([resourceId]),
    } });
}

type CounterSnapshot = TeamCredentialUsageCounterIdentity & Readonly<{
    limit: TeamCredentialUsageLimitRow;
}>;

function counterSnapshot(limit: TeamCredentialUsageLimitRow, actorAccountId: string,
    custodianAccountId: string, now: Date): CounterSnapshot {
    const bounds = resolveUsageBucketBounds(limit.period, now.getTime(), 0);
    return { resourceId: limit.resourceId, limitId: limit.id,
        actorAccountId: limit.subjectKind === 'each_member' ? actorAccountId : '',
        bucketStartMs: bounds.bucketStartMs, bucketEndMs: bounds.bucketEndMs, limit, custodianAccountId };
}

/** Rebuild only at first consumption or a source mutation, using the existing accounting fold. */
async function reconstructCountersInTx(tx: Tx, snapshots: readonly CounterSnapshot[]) {
    const values = new Map<string, TeamCredentialUsageCounterValue>();
    const byEnd = new Map<number, CounterSnapshot[]>();
    for (const snapshot of snapshots) {
        const group = byEnd.get(snapshot.bucketEndMs) ?? [];
        group.push(snapshot);
        byEnd.set(snapshot.bucketEndMs, group);
    }
    for (const [endMs, group] of byEnd) {
        const requests = group.map(snapshot => ({
            resultKey: teamCredentialUsageCounterKey(snapshot), resourceId: snapshot.resourceId,
            actorAccountId: snapshot.actorAccountId, now: new Date(snapshot.bucketStartMs),
            // Measurement is independent of the current maximum and enabled preference.
            limits: [{ ...snapshot.limit, maximum: '1' }], includeAllSubjects: true, includeDisabled: true,
        }));
        const evaluations = await evaluateResourcesFromDatabaseInTx(tx, {
            requests, now: new Date(endMs - 1), sourceEndMs: endMs - 1,
        });
        for (const snapshot of group) {
            const key = teamCredentialUsageCounterKey(snapshot);
            const result = evaluations.get(key);
            if (!result) throw new Error('Team spend reconstruction returned no measurement');
            const measurementUnavailable = !result.ok && 'unavailable' in result;
            const recorded = 'applied' in result ? result.applied[0]?.recorded : 0;
            if (recorded === undefined) throw new Error('Team spend reconstruction returned no recorded value');
            const value = { limitId: snapshot.limitId, actorAccountId: snapshot.actorAccountId, recorded, measurementUnavailable };
            await writeTeamCredentialUsageCounterInTx(tx, snapshot, value);
            values.set(key, value);
        }
    }
    return values;
}

export async function evaluateTeamCredentialUsageCountersInTx(tx: Tx, input: Readonly<{
    resourceId: string;
    custodianAccountId: string;
    actorAccountId: string;
    limits: readonly TeamCredentialUsageLimitInputRow[];
    currentGroupIds: readonly string[];
    now: Date;
}>): Promise<TeamCredentialUsageLimitEvaluation> {
    const limits = parseUsageLimitRows(input.limits);
    const applicable = selectApplicableTeamCredentialUsageLimits({ ...input, limits });
    const snapshots = applicable.filter(limit => parseMaximum(limit.maximum) !== null)
        .map(limit => counterSnapshot(limit, input.actorAccountId, input.custodianAccountId, input.now));
    const values = await readTeamCredentialUsageCountersInTx(tx, snapshots);
    const missing = snapshots.filter(snapshot => !values.has(teamCredentialUsageCounterKey(snapshot)))
        .sort((left, right) => teamCredentialUsageCounterKey(left).localeCompare(teamCredentialUsageCounterKey(right)));
    if (missing.length > 0) {
        await lockResourcesInTx(tx, [input.resourceId]);
        for (const snapshot of missing) await lockTeamCredentialUsageCounterInTx(tx, snapshot, snapshot.custodianAccountId);
        // A concurrent first reader may have reconstructed while this writer waited.
        const initialized = await readTeamCredentialUsageCountersInTx(tx, missing);
        for (const [key, value] of initialized) values.set(key, value);
        const reconstructed = await reconstructCountersInTx(tx,
            missing.filter(snapshot => !values.has(teamCredentialUsageCounterKey(snapshot))));
        for (const [key, value] of reconstructed) values.set(key, value);
    }
    const measurements = new Map(snapshots.map(snapshot => {
        const value = values.get(teamCredentialUsageCounterKey(snapshot));
        if (!value) throw new Error('Team spend counter was not initialized');
        return [snapshot.limitId, value] as const;
    }));
    return evaluateTeamCredentialUsageLimits({ ...input, limits, events: [], measurements });
}

/** Source corrections, terminal observations and deletions own their existing consumed projections. */
export async function refreshTeamCredentialUsageCountersInTx(tx: Tx, input: Readonly<{
    resourceIds?: readonly string[];
    sessionIds?: readonly string[];
    changedObservedAts: readonly Date[];
}>): Promise<void> {
    const sessionResources = input.sessionIds?.length ? await tx.usageEvent.groupBy({
        by: ['teamCredentialResourceId'], _min: { observedAt: true }, _max: { observedAt: true },
        where: { sessionId: { in: [...input.sessionIds] }, teamCredentialResourceId: { not: null } },
    }) : [];
    const resourceIds = [...new Set([...(input.resourceIds ?? []),
        ...sessionResources.flatMap(row => row.teamCredentialResourceId ? [row.teamCredentialResourceId] : [])])];
    if (resourceIds.length === 0) return;
    // A cumulative/native correction can affect other observations in its Session.
    // Reuse this query's actual extent; unrelated retained periods remain untouched.
    const affectedDates = [...input.changedObservedAts, ...sessionResources.flatMap(row => [
        ...(row._min.observedAt ? [row._min.observedAt] : []),
        ...(row._max.observedAt ? [row._max.observedAt] : []),
    ])];
    const observedRange = { startMs: Infinity, endMs: -Infinity };
    for (const date of affectedDates) {
        observedRange.startMs = Math.min(observedRange.startMs, date.getTime());
        observedRange.endMs = Math.max(observedRange.endMs, date.getTime());
    }
    await lockResourcesInTx(tx, resourceIds);
    const resources = await tx.teamCredentialResource.findMany({
        where: { id: { in: resourceIds } },
        select: { id: true, custodianAccountId: true, usageLimits: true },
    });
    const rows = await listTeamCredentialUsageCountersInTx(tx, {
        resourceIds, accountIds: resources.map(resource => resource.custodianAccountId), observedRange,
    });
    if (rows.length === 0) return;
    const limits = new Map(resources.flatMap(resource => parseUsageLimitRows(resource.usageLimits)
        .map(limit => [limit.id, { limit, custodianAccountId: resource.custodianAccountId }] as const)));
    const snapshots = rows.flatMap(row => {
        const owner = limits.get(row.limitId);
        return owner ? [{ ...owner, resourceId: owner.limit.resourceId, limitId: row.limitId,
            actorAccountId: row.actorAccountId, bucketStartMs: row.bucketStartMs, bucketEndMs: row.bucketEndMs }] : [];
    }).sort((left, right) => teamCredentialUsageCounterKey(left).localeCompare(teamCredentialUsageCounterKey(right)));
    for (const snapshot of snapshots) await lockTeamCredentialUsageCounterInTx(tx, snapshot, snapshot.custodianAccountId);
    await reconstructCountersInTx(tx, snapshots);
}

/** Immutable admissions increment requests; they never replay Session usage history. */
export async function recordTeamCredentialAdmissionCountersInTx(tx: Tx, input: Readonly<{
    usageEventId: string;
    resourceId: string;
    actorAccountId: string;
    sessionId: string | null;
    turnId: string | null;
    observedAt: Date;
    deliveryMode: string;
    groupIds: readonly string[];
}>): Promise<void> {
    if (input.deliveryMode !== 'brokered' && input.deliveryMode !== 'external_api') return;
    const resource = await tx.teamCredentialResource.findUnique({
        where: { id: input.resourceId }, select: { custodianAccountId: true, usageLimits: true },
    });
    if (!resource) return;
    const limits = parseUsageLimitRows(resource.usageLimits);
    const event: TeamCredentialUsageLimitEvent = {
        id: input.usageEventId, observedAt: input.observedAt, resourceId: input.resourceId,
        actorAccountId: input.actorAccountId, requestCount: 1, totalTokens: null,
        tokens: { input: null, output: null, reasoning: null, cacheRead: null, cacheWrite: null, total: null },
        effectiveCostUsd: null, costMeasurementExpected: false, deliveryMode: input.deliveryMode,
        groupAdmissions: input.groupIds.map(groupId => ({ groupId, observedAtMs: input.observedAt.getTime() })),
        turnStartedAtMs: null,
    };
    const snapshots = limits.filter(limit => limit.metric === 'inference_requests'
        && measureTeamCredentialUsageLimit({ limit, actorAccountId: input.actorAccountId,
            events: [event], now: input.observedAt }).recorded > 0)
        .map(limit => counterSnapshot(limit, input.actorAccountId, resource.custodianAccountId, input.observedAt))
        .sort((left, right) => teamCredentialUsageCounterKey(left).localeCompare(teamCredentialUsageCounterKey(right)));
    // Producers use the same resource → counter lock order as source corrections.
    if (snapshots.length > 0) await lockResourcesInTx(tx, [input.resourceId]);
    for (const snapshot of snapshots) await lockTeamCredentialUsageCounterInTx(tx, snapshot, snapshot.custodianAccountId);
    const values = await readTeamCredentialUsageCountersInTx(tx, snapshots);
    const missing: CounterSnapshot[] = [];
    for (const snapshot of snapshots) {
        const value = values.get(teamCredentialUsageCounterKey(snapshot));
        if (value) await writeTeamCredentialUsageCounterInTx(tx, snapshot, { ...value, recorded: value.recorded + 1 });
        else missing.push(snapshot);
    }
    await reconstructCountersInTx(tx, missing);

    if (!input.sessionId || !input.turnId) return;
    // A first Group attribution can make an already-recorded indivisible turn
    // count against that Group. Repeated attributions change only request count.
    const groupLimits = limits.filter(limit => limit.subjectKind === 'team_group'
        && limit.metric !== 'inference_requests' && input.groupIds.includes(limit.subjectId));
    for (const limit of groupLimits) {
        const bounds = resolveUsageBucketBounds(limit.period, input.observedAt.getTime(), 0);
        const previous = await tx.usageEventTeamCredentialGroupAttribution.findFirst({
            where: { teamGroupId: limit.subjectId, usageEvent: {
                id: { not: input.usageEventId }, sessionId: input.sessionId, turnId: input.turnId,
                teamCredentialResourceId: input.resourceId, source: 'team_credential_admission',
                credentialDeliveryMode: { in: ['brokered', 'external_api'] },
                observedAt: { gte: new Date(Math.max(bounds.bucketStartMs, limit.createdAt.getTime())),
                    lt: new Date(bounds.bucketEndMs) },
            } }, select: { usageEventId: true },
        });
        if (!previous) {
            await refreshTeamCredentialUsageCountersInTx(tx, { resourceIds: [input.resourceId],
                // Each Group counter requires an admission within its own period.
                changedObservedAts: [input.observedAt],
            });
            break;
        }
    }
}
