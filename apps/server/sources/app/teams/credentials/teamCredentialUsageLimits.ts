import {
    TeamCredentialUsageLimitMetricV1Schema,
    TeamCredentialUsageLimitPeriodV1Schema,
    TeamCredentialUsageLimitSubjectKindV1Schema,
    type TeamCredentialUsageLimitMetricV1,
    type TeamCredentialUsageLimitPeriodV1,
    type TeamCredentialUsageLimitSubjectKindV1,
} from '@happier-dev/protocol/teams';
import { resolveUsageBucketBounds as resolveBucketBounds } from '@happier-dev/protocol';
import { resolveScopedUsageContributions } from '@/app/usage/query/resolveScopedUsageContributions';
import { toScopedUsageEventRow } from '@/app/usage/query/scopedUsageEventRow';
import { resolveEffectiveUsageCostUsd } from '@/app/usage/query/resolveUsageCostMode';
import {
    isEffectiveTeamGroupMembership,
    resolveEffectiveTeamGroupIdsForAccountInTx,
} from '@/app/teams/groups/effectiveGroupMembership';
import type { Tx } from '@/storage/inTx';

export type TeamCredentialUsageLimitRow = Readonly<{
    id: string;
    resourceId: string;
    subjectKind: TeamCredentialUsageLimitSubjectKindV1;
    subjectId: string;
    period: TeamCredentialUsageLimitPeriodV1;
    metric: TeamCredentialUsageLimitMetricV1;
    maximum: string;
    enabled: boolean;
    createdAt: Date;
}>;

type TeamCredentialUsageLimitInputRow = Readonly<
    Omit<TeamCredentialUsageLimitRow, 'subjectKind' | 'period' | 'metric'> & {
        subjectKind: string;
        period: string;
        metric: string;
    }
>;

export type TeamCredentialUsageLimitEvent = Readonly<{
    id: string;
    observedAt: Date;
    resourceId: string | null;
    actorAccountId: string | null;
    requestCount: number;
    totalTokens: number;
    effectiveCostUsd: number | null;
    costMeasurementExpected: boolean;
    deliveryMode: string | null;
    groupAdmissions: readonly Readonly<{ groupId: string; observedAtMs: number }>[];
    /** Canonical SessionTurn start, used so a newly-created token/cost limit
     * never charges an indivisible turn that was already active. */
    turnStartedAtMs: number | null;
}>;

export type TeamCredentialUsageLimitDecision = Readonly<{
    limitId: string;
    metric: TeamCredentialUsageLimitMetricV1;
    recorded: number;
    maximum: number;
    resetsAt: Date;
}>;

export type TeamCredentialUsageLimitEvaluation = Readonly<
    | { ok: true; applied: readonly TeamCredentialUsageLimitDecision[] }
    | { ok: false; denied: TeamCredentialUsageLimitDecision; applied: readonly TeamCredentialUsageLimitDecision[] }
    | {
        ok: false;
        unavailable: { limitId: string; metric: 'cost_usd'; reason: 'cost_limit_unavailable' };
    }
>;

function parseMaximum(value: string): number | null {
    if (!/^\d+(?:\.\d{1,8})?$/u.test(value)) return null;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
}

function periodToGranularity(period: TeamCredentialUsageLimitPeriodV1): 'day' | 'week' | 'month' {
    return period;
}

function isEventInLimitScope(
    event: TeamCredentialUsageLimitEvent,
    limit: TeamCredentialUsageLimitRow,
    actorAccountId: string,
    windowStartMs: number,
    windowEndMs: number,
): boolean {
    if (event.resourceId !== limit.resourceId) return false;
    if (event.deliveryMode !== 'brokered' && event.deliveryMode !== 'external_api') return false;
    if (limit.subjectKind === 'resource') return true;
    if (limit.subjectKind === 'each_member') return event.actorAccountId === actorAccountId;
    if (limit.subjectKind === 'team_member') return event.actorAccountId === limit.subjectId;
    return event.groupAdmissions.some((admission) => (
        admission.groupId === limit.subjectId
        && admission.observedAtMs >= windowStartMs
        && admission.observedAtMs < windowEndMs
    ));
}

function readMetric(event: TeamCredentialUsageLimitEvent, metric: TeamCredentialUsageLimitMetricV1): number | null {
    if (metric === 'inference_requests') return event.requestCount;
    if (metric === 'total_tokens') return event.totalTokens;
    return event.effectiveCostUsd;
}

function buildExternalAdmissionCorrelationKey(row: Readonly<{
    teamCredentialResourceId?: string | null;
    teamCredentialActorAccountId?: string | null;
    teamCredentialExternalApiKeyId?: string | null;
    externalKey?: string | null;
}>): string | null {
    if (
        !row.teamCredentialResourceId
        || !row.teamCredentialActorAccountId
        || !row.teamCredentialExternalApiKeyId
        || !row.externalKey
    ) return null;
    return JSON.stringify([
        row.teamCredentialResourceId,
        row.teamCredentialActorAccountId,
        row.teamCredentialExternalApiKeyId,
        row.externalKey,
    ]);
}

/**
 * Evaluates all matching ceilings from immutable UsageEvent facts. This is a
 * pure owner-level primitive so admission and resource analytics cannot drift.
 */
export function evaluateTeamCredentialUsageLimits(input: Readonly<{
    limits: readonly TeamCredentialUsageLimitRow[];
    events: readonly TeamCredentialUsageLimitEvent[];
    actorAccountId: string;
    currentGroupIds?: readonly string[];
    includeAllSubjects?: boolean;
    includeDisabled?: boolean;
    now: Date;
}>): TeamCredentialUsageLimitEvaluation {
    const currentGroupIds = new Set(input.currentGroupIds ?? []);
    const applicable = input.limits.filter((limit) => (input.includeDisabled || limit.enabled) && (
        input.includeAllSubjects || (
            (limit.subjectKind !== 'team_member' || limit.subjectId === input.actorAccountId)
            && (limit.subjectKind !== 'team_group' || currentGroupIds.has(limit.subjectId))
        )
    ));
    const applied: TeamCredentialUsageLimitDecision[] = [];
    const denied: TeamCredentialUsageLimitDecision[] = [];
    const unavailable: { limitId: string; metric: 'cost_usd'; reason: 'cost_limit_unavailable' }[] = [];
    for (const limit of applicable) {
        const maximum = parseMaximum(limit.maximum);
        if (maximum === null) {
            denied.push({
                limitId: limit.id,
                metric: limit.metric,
                recorded: Number.POSITIVE_INFINITY,
                maximum: 0,
                resetsAt: input.now,
            });
            continue;
        }
        const bounds = resolveBucketBounds(periodToGranularity(limit.period), input.now.getTime(), 0);
        const startMs = Math.max(bounds.bucketStartMs, limit.createdAt.getTime());
        let recorded = 0;
        let measurementUnavailable = false;
        for (const event of input.events) {
            if (!isEventInLimitScope(event, limit, input.actorAccountId, startMs, bounds.bucketEndMs)) continue;
            const observedAt = event.observedAt.getTime();
            if (observedAt < startMs || observedAt >= bounds.bucketEndMs) continue;
            if (
                limit.metric !== 'inference_requests'
                && event.turnStartedAtMs !== null
                && event.turnStartedAtMs < limit.createdAt.getTime()
            ) continue;
            const value = readMetric(event, limit.metric);
            if (value === null) {
                if (limit.metric === 'cost_usd' && event.costMeasurementExpected) measurementUnavailable = true;
                continue;
            }
            if (Number.isFinite(value) && value >= 0) recorded += value;
        }
        if (measurementUnavailable && limit.metric === 'cost_usd') {
            unavailable.push({ limitId: limit.id, metric: 'cost_usd', reason: 'cost_limit_unavailable' });
            continue;
        }
        const decision = { limitId: limit.id, metric: limit.metric, recorded, maximum, resetsAt: new Date(bounds.bucketEndMs) };
        applied.push(decision);
        if (recorded >= maximum) denied.push(decision);
    }
    if (unavailable.length > 0) return { ok: false, unavailable: unavailable[0]! };
    if (denied.length > 0) {
        const effectiveDenial = denied.reduce((latest, candidate) => (
            candidate.resetsAt.getTime() >= latest.resetsAt.getTime() ? candidate : latest
        ));
        return { ok: false, denied: effectiveDenial, applied };
    }
    return { ok: true, applied };
}

export function canonicalUsageLimitMaximum(value: string, metric: TeamCredentialUsageLimitMetricV1): string | null {
    const trimmed = value.trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,8})?$/u.test(trimmed)) return null;
    if (metric !== 'cost_usd' && !/^\d+$/u.test(trimmed)) return null;
    const parsed = Number(trimmed);
    if (!Number.isSafeInteger(parsed) && metric !== 'cost_usd') return null;
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return trimmed;
}

export type TeamCredentialUsageAdmissionLimitEvaluation =
    | Readonly<{
        ok: true;
        applied: readonly TeamCredentialUsageLimitDecision[];
        budgetGroupIds: readonly string[];
    }>
    | Readonly<{
        ok: false;
        denied: TeamCredentialUsageLimitDecision;
        applied: readonly TeamCredentialUsageLimitDecision[];
        budgetGroupIds: readonly string[];
    }>
    | Readonly<{
        ok: false;
        unavailable: { limitId: string; metric: 'cost_usd'; reason: 'cost_limit_unavailable' };
        budgetGroupIds: readonly string[];
    }>;

function parseUsageLimitRows(
    limits: readonly TeamCredentialUsageLimitInputRow[],
): TeamCredentialUsageLimitRow[] {
    return limits.map((limit) => {
        const subjectKind = TeamCredentialUsageLimitSubjectKindV1Schema.safeParse(limit.subjectKind);
        const period = TeamCredentialUsageLimitPeriodV1Schema.safeParse(limit.period);
        const metric = TeamCredentialUsageLimitMetricV1Schema.safeParse(limit.metric);
        if (!subjectKind.success || !period.success || !metric.success) {
            throw new Error(`invalid Team credential usage limit row: ${limit.id}`);
        }
        return { ...limit, subjectKind: subjectKind.data, period: period.data, metric: metric.data };
    });
}

type TeamCredentialUsageDatabaseEvaluationRequest = Readonly<{
    resourceId: string;
    actorAccountId: string;
    limits: readonly TeamCredentialUsageLimitInputRow[];
    includeAllSubjects?: boolean;
    includeDisabled?: boolean;
    currentGroupIds?: readonly string[];
}>;

async function evaluateResourcesFromDatabaseInTx(
    tx: Tx,
    input: Readonly<{
        requests: readonly TeamCredentialUsageDatabaseEvaluationRequest[];
        now: Date;
    }>,
): Promise<Map<string, TeamCredentialUsageLimitEvaluation>> {
    const results = new Map<string, TeamCredentialUsageLimitEvaluation>();
    const requests = input.requests.map((request) => ({
        ...request,
        limits: parseUsageLimitRows(request.limits),
    }));
    for (const request of requests) {
        if (request.limits.length === 0) results.set(request.resourceId, { ok: true, applied: [] });
    }
    const requestsWithLimits = requests.filter((request) => request.limits.length > 0);
    if (requestsWithLimits.length === 0) return results;

    const earliestStartByResourceId = new Map(requestsWithLimits.map((request) => [
        request.resourceId,
        Math.min(...request.limits.map((limit) => {
            const bounds = resolveBucketBounds(periodToGranularity(limit.period), input.now.getTime(), 0);
            return Math.max(bounds.bucketStartMs, limit.createdAt.getTime());
        })),
    ]));
    const earliestStartMs = Math.min(...earliestStartByResourceId.values());
    const resourceIds = requestsWithLimits.map((request) => request.resourceId);
    const candidateResourceRows = await tx.usageEvent.findMany({
        where: {
            teamCredentialResourceId: { in: resourceIds },
            observedAt: { gte: new Date(earliestStartMs), lte: input.now },
        },
        orderBy: [{ observedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const resourceRows = candidateResourceRows.filter((row) => (
        row.teamCredentialResourceId !== null
        && row.observedAt.getTime() >= (earliestStartByResourceId.get(row.teamCredentialResourceId) ?? Number.POSITIVE_INFINITY)
    ));
    const sessionIds = [...new Set(resourceRows.flatMap((row) => row.sessionId ? [row.sessionId] : []))];
    const rows = sessionIds.length === 0 ? resourceRows : await tx.usageEvent.findMany({
        where: {
            OR: [
                { id: { in: resourceRows.map((row) => row.id) } },
                { sessionId: { in: sessionIds }, observedAt: { lte: input.now } },
            ],
        },
        orderBy: [{ observedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const groupRows = resourceRows.length === 0 ? [] : await tx.usageEventTeamCredentialGroupAttribution.findMany({
        where: { usageEventId: { in: resourceRows.map((row) => row.id) } },
        select: { usageEventId: true, teamGroupId: true },
    });
    const resourceRowsById = new Map(resourceRows.map((row) => [row.id, row]));
    const groupAdmissionsByEventId = new Map<string, Map<string, number>>();
    for (const row of groupRows) {
        const usageEvent = resourceRowsById.get(row.usageEventId);
        if (
            !usageEvent
            || usageEvent.source !== 'team_credential_admission'
            || (usageEvent.credentialDeliveryMode !== 'brokered' && usageEvent.credentialDeliveryMode !== 'external_api')
        ) continue;
        const admissions = groupAdmissionsByEventId.get(row.usageEventId) ?? new Map<string, number>();
        admissions.set(row.teamGroupId, usageEvent.observedAt.getTime());
        groupAdmissionsByEventId.set(row.usageEventId, admissions);
    }
    const groupAdmissionsByTurn = new Map<string, Map<string, Set<number>>>();
    const groupAdmissionsByExternalCorrelation = new Map<string, Map<string, Set<number>>>();
    for (const row of resourceRows) {
        const eventAdmissions = groupAdmissionsByEventId.get(row.id);
        if (!eventAdmissions) continue;
        if (row.sessionId && row.turnId) {
            const key = JSON.stringify([row.sessionId, row.turnId, row.teamCredentialResourceId]);
            const turnAdmissions = groupAdmissionsByTurn.get(key) ?? new Map<string, Set<number>>();
            for (const [groupId, observedAtMs] of eventAdmissions) {
                const observedAtValues = turnAdmissions.get(groupId) ?? new Set<number>();
                observedAtValues.add(observedAtMs);
                turnAdmissions.set(groupId, observedAtValues);
            }
            groupAdmissionsByTurn.set(key, turnAdmissions);
        }
        const externalCorrelationKey = buildExternalAdmissionCorrelationKey(row);
        if (!externalCorrelationKey) continue;
        const externalAdmissions = groupAdmissionsByExternalCorrelation.get(externalCorrelationKey)
            ?? new Map<string, Set<number>>();
        for (const [groupId, observedAtMs] of eventAdmissions) {
            const observedAtValues = externalAdmissions.get(groupId) ?? new Set<number>();
            observedAtValues.add(observedAtMs);
            externalAdmissions.set(groupId, observedAtValues);
        }
        groupAdmissionsByExternalCorrelation.set(externalCorrelationKey, externalAdmissions);
    }
    const { bucketAttributions } = resolveScopedUsageContributions(rows.map(toScopedUsageEventRow));
    const turnReferences = [...new Map(bucketAttributions.flatMap((row) => (
        row.sessionId && row.turnId
            ? [[JSON.stringify([row.sessionId, row.turnId]), { sessionId: row.sessionId, turnId: row.turnId }] as const]
            : []
    ))).values()];
    const turnRows = turnReferences.length === 0 ? [] : await tx.sessionTurn.findMany({
        where: {
            OR: turnReferences.map(({ sessionId, turnId }) => ({ sessionId, turnId })),
        },
        select: { sessionId: true, turnId: true, startedAt: true },
    });
    const turnStartedAtByKey = new Map(turnRows.map((turn) => [
        JSON.stringify([turn.sessionId, turn.turnId]),
        Number(turn.startedAt),
    ]));
    const events: TeamCredentialUsageLimitEvent[] = bucketAttributions.map((row) => {
        const directlyAttributedAdmissions = row.contributingEventIds.flatMap((id) => (
            [...(groupAdmissionsByEventId.get(id) ?? [])]
        ));
        const turnAdmissions = row.sessionId && row.turnId && row.teamCredentialResourceId
            ? groupAdmissionsByTurn.get(JSON.stringify([row.sessionId, row.turnId, row.teamCredentialResourceId]))
            : undefined;
        const externalAdmissions = groupAdmissionsByExternalCorrelation.get(
            buildExternalAdmissionCorrelationKey(row) ?? '',
        );
        const groupAdmissions = new Map<string, { groupId: string; observedAtMs: number }>();
        for (const [groupId, observedAtMs] of directlyAttributedAdmissions) {
            groupAdmissions.set(JSON.stringify([groupId, observedAtMs]), { groupId, observedAtMs });
        }
        for (const [groupId, observedAtValues] of [...(turnAdmissions ?? []), ...(externalAdmissions ?? [])]) {
            for (const observedAtMs of observedAtValues) {
                groupAdmissions.set(JSON.stringify([groupId, observedAtMs]), { groupId, observedAtMs });
            }
        }
        return {
            id: row.id,
            observedAt: row.observedAt,
            resourceId: row.teamCredentialResourceId ?? null,
            actorAccountId: row.teamCredentialActorAccountId ?? null,
            requestCount: row.requestCount ?? 0,
            totalTokens: row.tokens.total,
            effectiveCostUsd: row.cost.costSource === 'none' ? null : resolveEffectiveUsageCostUsd(row.cost, 'auto'),
            costMeasurementExpected: row.source !== 'team_credential_admission',
            deliveryMode: row.credentialDeliveryMode ?? null,
            groupAdmissions: [...groupAdmissions.values()],
            turnStartedAtMs: row.sessionId && row.turnId
                ? turnStartedAtByKey.get(JSON.stringify([row.sessionId, row.turnId])) ?? null
                : null,
        };
    });
    for (const request of requestsWithLimits) {
        results.set(request.resourceId, evaluateTeamCredentialUsageLimits({
            limits: request.limits,
            events,
            actorAccountId: request.actorAccountId,
            currentGroupIds: request.currentGroupIds,
            includeAllSubjects: request.includeAllSubjects,
            includeDisabled: request.includeDisabled,
            now: input.now,
        }));
    }
    return results;
}

/**
 * The pre-forward broker hook. It evaluates only recorded usage and returns
 * the current matching budget Groups that a later admitted terminal event must
 * preserve. It deliberately writes no reservation or UsageEvent.
 */
export async function evaluateTeamCredentialUsageAdmissionLimitsInTx(
    tx: Tx,
    input: Readonly<{ resourceId: string; actorAccountId: string; now?: Date }>,
): Promise<TeamCredentialUsageAdmissionLimitEvaluation> {
    const evaluations = await evaluateTeamCredentialUsageAdmissionLimitsForResourcesInTx(tx, {
        resourceIds: [input.resourceId],
        actorAccountId: input.actorAccountId,
        now: input.now,
    });
    return evaluations.get(input.resourceId) ?? { ok: true, applied: [], budgetGroupIds: [] };
}

/**
 * Set-oriented admission evaluation for one bounded resource catalog page.
 * Rules and immutable usage facts are loaded in a constant number of queries,
 * then the canonical pure evaluator projects an exact decision per resource.
 */
export async function evaluateTeamCredentialUsageAdmissionLimitsForResourcesInTx(
    tx: Tx,
    input: Readonly<{ resourceIds: readonly string[]; actorAccountId: string; now?: Date }>,
): Promise<Map<string, TeamCredentialUsageAdmissionLimitEvaluation>> {
    const resourceIds = [...new Set(input.resourceIds)];
    const empty = () => ({ ok: true, applied: [], budgetGroupIds: [] } as const);
    const results = new Map<string, TeamCredentialUsageAdmissionLimitEvaluation>(
        resourceIds.map((resourceId) => [resourceId, empty()]),
    );
    if (resourceIds.length === 0) return results;
    const now = input.now ?? new Date();
    const [resources, limitRows] = await Promise.all([
        tx.teamCredentialResource.findMany({
            where: { id: { in: resourceIds } },
            select: { id: true, teamId: true },
        }),
        tx.teamCredentialUsageLimit.findMany({
            where: { resourceId: { in: resourceIds }, enabled: true },
            orderBy: { createdAt: 'asc' },
        }),
    ]);
    const resourceById = new Map(resources.map((resource) => [resource.id, resource]));
    const limitsByResourceId = new Map<string, typeof limitRows>();
    for (const limit of limitRows) {
        const limits = limitsByResourceId.get(limit.resourceId) ?? [];
        limits.push(limit);
        limitsByResourceId.set(limit.resourceId, limits);
    }
    const groupLimitedTeamIds = [...new Set(limitRows.flatMap((limit) => {
        if (limit.subjectKind !== 'team_group') return [];
        const resource = resourceById.get(limit.resourceId);
        return resource ? [resource.teamId] : [];
    }))];
    const membershipRows = groupLimitedTeamIds.length === 0 ? [] : await tx.teamMembership.findMany({
        where: { teamId: { in: groupLimitedTeamIds }, accountId: input.actorAccountId },
        select: {
            teamId: true,
            status: true,
            account: { select: { status: true } },
            team: { select: { archivedAt: true } },
            groupMemberships: {
                select: { group: { select: { id: true, archivedAt: true } } },
            },
        },
    });
    const currentGroupIdsByTeamId = new Map(membershipRows.map((membership) => [
        membership.teamId,
        membership.groupMemberships
            .filter(({ group }) => isEffectiveTeamGroupMembership({
                accountStatus: membership.account.status,
                membershipStatus: membership.status,
                teamArchivedAt: membership.team.archivedAt,
                groupArchivedAt: group.archivedAt,
            }))
            .map(({ group }) => group.id)
            .sort(),
    ]));
    const requests = resources.map((resource) => ({
        resourceId: resource.id,
        actorAccountId: input.actorAccountId,
        limits: limitsByResourceId.get(resource.id) ?? [],
        currentGroupIds: currentGroupIdsByTeamId.get(resource.teamId) ?? [],
    }));
    const evaluations = await evaluateResourcesFromDatabaseInTx(tx, { requests, now });
    for (const request of requests) {
        const currentGroupIdSet = new Set(request.currentGroupIds);
        const budgetGroupIds = [...new Set(request.limits.flatMap((limit) => (
            limit.subjectKind === 'team_group' && currentGroupIdSet.has(limit.subjectId)
                ? [limit.subjectId]
                : []
        )))].sort();
        results.set(request.resourceId, {
            ...(evaluations.get(request.resourceId) ?? { ok: true, applied: [] }),
            budgetGroupIds,
        });
    }
    return results;
}

/** Projects current windows through the same canonical evaluator admission uses. */
export async function projectTeamCredentialUsageLimitsInTx(
    tx: Tx,
    input: Readonly<{
        resourceId: string;
        actorAccountId: string;
        limits: readonly TeamCredentialUsageLimitRow[];
        now?: Date;
    }>,
): Promise<TeamCredentialUsageLimitEvaluation> {
    return evaluateFromDatabaseInTx(tx, { ...input, includeAllSubjects: true, includeDisabled: true });
}

async function evaluateFromDatabaseInTx(
    tx: Tx,
    input: Readonly<{
        resourceId: string;
        actorAccountId: string;
        limits?: readonly TeamCredentialUsageLimitInputRow[];
        includeAllSubjects?: boolean;
        includeDisabled?: boolean;
        currentGroupIds?: readonly string[];
        now?: Date;
    }>,
): Promise<TeamCredentialUsageLimitEvaluation> {
    const now = input.now ?? new Date();
    const limits = input.limits ?? await tx.teamCredentialUsageLimit.findMany({
        where: { resourceId: input.resourceId, enabled: true },
        orderBy: { createdAt: 'asc' },
    });
    if (limits.length === 0) return { ok: true, applied: [] };

    const parsedLimits = parseUsageLimitRows(limits);

    const groupLimits = parsedLimits.filter((limit) => limit.subjectKind === 'team_group');
    const resource = groupLimits.length > 0
        ? await tx.teamCredentialResource.findUnique({ where: { id: input.resourceId }, select: { teamId: true } })
        : null;
    const currentGroupIds = input.currentGroupIds ?? (resource
        ? await resolveEffectiveTeamGroupIdsForAccountInTx(tx, {
            teamId: resource.teamId,
            accountId: input.actorAccountId,
        })
        : []);

    const evaluations = await evaluateResourcesFromDatabaseInTx(tx, {
        requests: [{
            resourceId: input.resourceId,
            actorAccountId: input.actorAccountId,
            limits: parsedLimits,
            currentGroupIds,
            includeAllSubjects: input.includeAllSubjects,
            includeDisabled: input.includeDisabled,
        }],
        now,
    });
    return evaluations.get(input.resourceId) ?? { ok: true, applied: [] };
}
