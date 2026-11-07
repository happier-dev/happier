import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
    TeamCredentialUsageLimitMetricV1Schema,
    TeamCredentialUsageLimitPeriodV1Schema,
    TeamCredentialUsageLimitSubjectKindV1Schema,
    TeamCredentialUsageQueryResultV1Schema,
    decodeTeamKeysetCursorV1,
    encodeTeamKeysetCursorV1,
    readTeamKeysetTextV1,
} from '@happier-dev/protocol/teams';
import type {
    TeamCredentialUsageBreakdownDimensionV1,
    TeamCredentialUsageQueryInputV1,
    TeamCredentialUsageQueryResultV1,
} from '@happier-dev/protocol/teams';
import { inTx, type Tx } from '@/storage/inTx';
import { resolveAccountDisplayLabelV1 } from '@/app/account/profile/accountDisplayProfile';
import type { TeamOperationAuthenticationContext } from '../actorContext';
import { SESSION_ACCESS_SESSION_BATCH_SIZE } from '@/app/session/access/sessionAccess';
import { authorizeTeamCredentialUsageSubjectInTx } from './resourceUsageSubject';
import { resolveScopedUsageContributions, type ScopedUsageContribution, type ScopedUsageEventRow } from '@/app/usage/query/resolveScopedUsageContributions';
import { toScopedUsageEventRow } from '@/app/usage/query/scopedUsageEventRow';
import { addUsageCostForMode, withEffectiveUsageCost, type UsageCostMode } from '@/app/usage/query/resolveUsageCostMode';
import { addUsageTokens, createEmptyUsageCost, createEmptyUsageTokens } from '@/app/usage/usageMetrics';
import { resolveUsageBucketBounds as resolveBucketBounds } from '@happier-dev/protocol/usage/usageCalendar';
import { projectTeamCredentialUsageLimitsInTx, type TeamCredentialUsageLimitRow } from './teamCredentialUsageLimits';
import { resolveEffectiveSessionAccessWhere } from '@/app/session/access/sessionAccessWhere';
import { isSessionTranscriptShareable, SESSION_TRANSCRIPT_PUBLICATION_SELECT } from '@/app/session/sessionTranscriptPublicationPolicy';
import { resolveEffectiveTeamGroupIdsForAccountInTx } from '../groups/effectiveGroupMembership';
import { classifyTeamCredentialUsageObservationSource } from '@/app/usage/usageSourceClassifier';

const UNAVAILABLE_SESSION_KEY = 'unavailable_session';
const UNAVAILABLE_WORKER_MACHINE_KEY = 'unavailable_worker_machine';

function breakdownKey(
    row: ScopedUsageEventRow,
    dimension: TeamCredentialUsageBreakdownDimensionV1,
    visibility: Readonly<{ manager: boolean; readableSessionIds: ReadonlySet<string> }>,
): string | null {
    if (dimension === 'member') return row.teamCredentialActorAccountId ?? null;
    if (dimension === 'external_api_key') return row.teamCredentialExternalApiKeyId ?? null;
    if (dimension === 'model') return row.modelId;
    if (dimension === 'session') {
        return row.sessionId && visibility.readableSessionIds.has(row.sessionId)
            ? row.sessionId
            : UNAVAILABLE_SESSION_KEY;
    }
    if (dimension === 'source_member') return row.teamCredentialSourceCredentialId ?? null;
    if (dimension === 'worker_machine') {
        if (visibility.manager) return row.machineId ?? null;
        return row.sessionId && visibility.readableSessionIds.has(row.sessionId)
            ? row.machineId ?? null
            : UNAVAILABLE_WORKER_MACHINE_KEY;
    }
    if (dimension === 'broker_machine') return row.brokerMachineId ?? null;
    return row.credentialDeliveryMode ?? null;
}

function aggregate(rows: readonly ScopedUsageContribution[], costMode: UsageCostMode) {
    const ids = new Set<string>();
    let tokens = createEmptyUsageTokens();
    let cost = createEmptyUsageCost();
    let requestCount = 0;
    for (const row of rows) {
        for (const id of row.contributingEventIds) ids.add(id);
        tokens = addUsageTokens(tokens, row.tokens);
        // Cost-mode precedence resolves the several price representations of
        // one contribution; it is not an operation on a merged column set.
        // Resolving it per contribution is the canonical usage accumulator
        // personal analytics already consumes, so a reported contribution plus
        // an estimated one is their sum rather than only the reported one.
        cost = addUsageCostForMode(cost, row.cost, costMode);
        requestCount += row.requestCount ?? 0;
    }
    return {
        eventCount: ids.size,
        requestCount,
        tokens,
        cost: withEffectiveUsageCost(cost, costMode),
    };
}

function hasExternalTerminalObservationForAdmission(
    admission: ScopedUsageEventRow,
    rows: readonly ScopedUsageEventRow[],
): boolean {
    return rows.some((row) => row.source === 'team_credential_external_terminal'
        && row.externalKey === admission.externalKey
        && row.teamCredentialExternalApiKeyId === admission.teamCredentialExternalApiKeyId
        && row.teamCredentialActorAccountId === admission.teamCredentialActorAccountId);
}

function hasAgentObservationForAdmission(
    admission: ScopedUsageEventRow,
    agentObservations: readonly ScopedUsageEventRow[],
): boolean {
    if (!admission.sessionId || !admission.turnId) return false;
    return agentObservations.some((row) => row.sessionId === admission.sessionId
        && row.turnId === admission.turnId
        && row.teamCredentialResourceId === admission.teamCredentialResourceId
        && row.teamCredentialActorAccountId === admission.teamCredentialActorAccountId);
}

function externalTerminalMeasurement(row: ScopedUsageEventRow): 'reported' | 'unavailable' {
    const metadata = row.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return 'unavailable';
    return Reflect.get(metadata, 'measurement') === 'reported' ? 'reported' : 'unavailable';
}

/**
 * `directUsePossible` is the reader-scoped delivery fact: the resource (or, for
 * a member reading their own use, that member) currently may receive direct
 * material or has already received it. Usage rows cannot answer that — an
 * empty or brokered-only period says nothing about use outside Happier — so the
 * caller derives it from the resource audience and retained delivery history.
 */
export function projectTeamCredentialUsageCoverage(
    rows: readonly ScopedUsageEventRow[],
    input: Readonly<{ directUsePossible: boolean }>,
) {
    const classified = rows.map((row) => ({
        row,
        observationClass: classifyTeamCredentialUsageObservationSource(row.source),
    }));
    const admissions = classified
        .filter((entry) => entry.observationClass === 'request_admission')
        .map((entry) => entry.row);
    const agentObservations = classified
        .filter((entry) => entry.observationClass === 'agent_observed')
        .map((entry) => entry.row);
    const externalTerminalObservations = classified
        .filter((entry) => entry.observationClass === 'external_terminal')
        .map((entry) => entry.row);
    const externalAdmissions = admissions.filter((row) => row.credentialDeliveryMode === 'external_api');
    const unobservedExternalRequestCount = externalAdmissions
        .filter((admission) => !hasExternalTerminalObservationForAdmission(admission, rows))
        .reduce((sum, admission) => sum + (admission.requestCount ?? 0), 0);
    const directRecordedUseOnly = input.directUsePossible
        || rows.some((row) => row.credentialDeliveryMode === 'direct');
    const measuredExternalTerminalObservations = externalTerminalObservations.filter(
        (row) => externalTerminalMeasurement(row) === 'reported',
    );
    const tokenObservationCount = agentObservations.length + measuredExternalTerminalObservations.length;
    const uncoveredAdmissionCount = admissions.reduce((sum, admission) => {
        const correlatedExternalTerminal = admission.credentialDeliveryMode === 'external_api'
            ? externalTerminalObservations.find((terminal) => (
                terminal.externalKey === admission.externalKey
                && terminal.teamCredentialExternalApiKeyId === admission.teamCredentialExternalApiKeyId
                && terminal.teamCredentialActorAccountId === admission.teamCredentialActorAccountId
            ))
            : undefined;
        const covered = correlatedExternalTerminal !== undefined
            ? externalTerminalMeasurement(correlatedExternalTerminal) === 'reported'
            : admission.credentialDeliveryMode !== 'external_api'
                && hasAgentObservationForAdmission(admission, agentObservations);
        return covered ? sum : sum + (admission.requestCount ?? 0);
    }, 0);
    const tokenCoverage = tokenObservationCount === 0
        ? 'unavailable' as const
        : directRecordedUseOnly || uncoveredAdmissionCount > 0
            ? 'partial' as const
            : 'complete' as const;
    const observedUsage = [...agentObservations, ...externalTerminalObservations];
    const pricedObservationCount = observedUsage.filter((row) => row.cost.costSource !== null
        && row.cost.costSource !== 'none').length;
    const uncoveredCostAdmissionCount = admissions.reduce((sum, admission) => {
        const correlatedObservations = admission.credentialDeliveryMode === 'external_api'
            ? externalTerminalObservations.filter((terminal) => (
                terminal.externalKey === admission.externalKey
                && terminal.teamCredentialExternalApiKeyId === admission.teamCredentialExternalApiKeyId
                && terminal.teamCredentialActorAccountId === admission.teamCredentialActorAccountId
            ))
            : agentObservations.filter((row) => admission.sessionId !== null
                && admission.turnId !== null
                && row.sessionId === admission.sessionId
                && row.turnId === admission.turnId
                && row.teamCredentialResourceId === admission.teamCredentialResourceId
                && row.teamCredentialActorAccountId === admission.teamCredentialActorAccountId);
        const covered = correlatedObservations.some((row) => row.cost.costSource !== null
            && row.cost.costSource !== 'none');
        return covered ? sum : sum + (admission.requestCount ?? 0);
    }, 0);
    const costCoverage = pricedObservationCount === 0
        ? 'unavailable' as const
        : directRecordedUseOnly
            || uncoveredCostAdmissionCount > 0
            || pricedObservationCount < observedUsage.length
            ? 'partial' as const
            : 'complete' as const;

    return {
        requestAdmissionCount: admissions.reduce((sum, row) => sum + (row.requestCount ?? 0), 0),
        agentObservationCount: agentObservations.length,
        externalTerminalObservationCount: externalTerminalObservations.length,
        directRecordedUseOnly,
        requestCountCoverage: directRecordedUseOnly ? 'brokered_only' as const : 'complete' as const,
        tokenCoverage,
        costCoverage,
        unobservedExternalRequestCount,
    };
}

function buildSeries(
    rows: readonly ScopedUsageContribution[],
    granularity: TeamCredentialUsageQueryInputV1['granularity'],
    costMode: UsageCostMode,
) {
    const buckets = new Map<number, ScopedUsageContribution[]>();
    for (const row of rows) {
        const bounds = resolveBucketBounds(granularity, row.observedAt.getTime(), 0);
        const bucket = buckets.get(bounds.bucketStartMs) ?? [];
        bucket.push(row);
        buckets.set(bounds.bucketStartMs, bucket);
    }
    return [...buckets.entries()].sort(([left], [right]) => left - right).map(([bucketStartMs, bucketRows]) => {
        const { bucketEndMs } = resolveBucketBounds(granularity, bucketStartMs, 0);
        return { bucketStartMs, bucketEndMs, totals: aggregate(bucketRows, costMode) };
    });
}

/**
 * The query a breakdown cursor is bound to, at a fixed width.
 *
 * The codec only ever compares this value for equality, so a digest binds the
 * cursor to exactly the same query the literal identity did. Width matters:
 * both the query identity and its breakdown anchor must fit the shared codec
 * without limiting the resource or model identities returned in the page.
 */
function usageBreakdownCursorQueryKey(input: TeamCredentialUsageQueryInputV1): string {
    return createHash('sha256').update(JSON.stringify([
        'team-credential-usage-breakdown:v2', input.resourceId ?? input.subject, input.startMs, input.endMs,
        input.granularity, input.costMode, input.breakdown ?? null,
    ]), 'utf8').digest('base64url');
}

function usageBreakdownCursorAnchor(key: string): string {
    return createHash('sha256').update(key, 'utf8').digest('base64url');
}

/**
 * Resolves display-safe labels for exactly the slices the viewer is already
 * authorized to see. Labels never widen authorization: member names come from
 * the Account display owner and external-key labels from safe key metadata —
 * never digests, source internals, or unreadable Sessions.
 */
async function resolveBreakdownLabelsInTx(
    tx: Tx,
    input: Readonly<{
        dimension: TeamCredentialUsageBreakdownDimensionV1;
        keys: readonly string[];
        resourceId?: string;
    }>,
): Promise<ReadonlyMap<string, string>> {
    const keys = [...new Set(input.keys)];
    if (keys.length === 0) return new Map();
    if (input.dimension === 'session' && keys.includes(UNAVAILABLE_SESSION_KEY)) {
        return new Map([[UNAVAILABLE_SESSION_KEY, 'Unavailable session']]);
    }
    if (input.dimension === 'worker_machine' && keys.includes(UNAVAILABLE_WORKER_MACHINE_KEY)) {
        return new Map([[UNAVAILABLE_WORKER_MACHINE_KEY, 'Unavailable machine']]);
    }
    if (input.dimension === 'member') {
        const accounts = await tx.account.findMany({
            where: { id: { in: keys } },
            select: { id: true, name: true, username: true },
        });
        return new Map(accounts.flatMap((account) => {
            const displayName = resolveAccountDisplayLabelV1(account);
            return displayName ? [[account.id, displayName] as const] : [];
        }));
    }
    if (input.dimension === 'external_api_key') {
        const keys_ = await tx.teamCredentialExternalApiKey.findMany({
            where: { id: { in: keys }, resourceId: input.resourceId },
            select: { id: true, label: true },
        });
        return new Map(keys_.map((key) => [key.id, key.label]));
    }
    return new Map();
}

export async function queryTeamCredentialUsage(
    accountId: string,
    input: TeamCredentialUsageQueryInputV1,
    authentication: TeamOperationAuthenticationContext,
): Promise<TeamCredentialUsageQueryResultV1 | { ok: false; error: 'not_found_or_not_visible' | 'invalid_resource_input' | 'team_authentication_required' | 'team_authentication_policy_unavailable' | 'cost_limit_unavailable' }> {
    return await inTx<TeamCredentialUsageQueryResultV1 | { ok: false; error: 'not_found_or_not_visible' | 'invalid_resource_input' | 'team_authentication_required' | 'team_authentication_policy_unavailable' | 'cost_limit_unavailable' }>(async (tx) => {
        const auth = await authorizeTeamCredentialUsageSubjectInTx(tx, accountId, input, authentication);
        if (!auth.ok) return auth;
        const resourceIds = auth.resourceIds === null ? null : new Set(auth.resourceIds);
        const inSubject = (id: ScopedUsageEventRow['teamCredentialResourceId']) => id != null
            && (resourceIds === null || resourceIds.has(id));
        // Read the range through its resource index, then history through the
        // Session index. Keeping these as separate reads avoids a correlated OR
        // that scans unrelated usage and duplicates history during ORM batching.
        const scopes: Array<{ in: string[] } | { not: null }> = [];
        if (auth.resourceIds === null) scopes.push({ not: null });
        else {
            // These IDs also select readable Sessions below. Reuse the Session
            // access owner's bind budget, which reserves room for its predicate;
            // Prisma cannot auto-batch that predicate's negation filters.
            for (let index = 0; index < auth.resourceIds.length; index += SESSION_ACCESS_SESSION_BATCH_SIZE) {
                scopes.push({ in: auth.resourceIds.slice(index, index + SESSION_ACCESS_SESSION_BATCH_SIZE) });
            }
        }
        const resourceWheres = scopes.map(scope => ({
            teamCredentialResourceId: scope,
            observedAt: { gte: new Date(input.startMs), lte: new Date(input.endMs) },
            ...(auth.manager ? {} : { teamCredentialActorAccountId: accountId }),
        } satisfies Prisma.UsageEventWhereInput));
        const rangeRows = (await Promise.all(resourceWheres.map(where => tx.usageEvent.findMany({
            where, orderBy: [{ observedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        })))).flat();
        // Relational Session selection keeps the parameter set independent of
        // the number of Sessions. Its own read has no competing range OR arm.
        const histories = await Promise.all(resourceWheres.map(resourceWhere => tx.usageEvent.findMany({
            where: { session: { usageEvents: { some: resourceWhere } },
                observedAt: { lte: new Date(input.endMs) } },
            orderBy: [{ observedAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
        })));
        // The scoped contribution owner decides replay order, including equal-
        // clock runtime witnesses. This layer only removes repeated DB rows.
        const corridorRows = [...new Map([...rangeRows, ...histories.flat()].map(row => [row.id, row] as const)).values()];
        const inRange = (row: Pick<ScopedUsageEventRow,
            'teamCredentialResourceId' | 'observedAt' | 'teamCredentialActorAccountId'>) => inSubject(row.teamCredentialResourceId)
            && row.observedAt.getTime() >= input.startMs && row.observedAt.getTime() <= input.endMs
            && (auth.manager || row.teamCredentialActorAccountId === accountId);
        const resourceRows = corridorRows.filter(inRange);
        const { bucketAttributions } = resolveScopedUsageContributions(corridorRows.map(toScopedUsageEventRow));
        const totalContributions = bucketAttributions.filter(inRange);
        const rows = resourceRows;
        const costMode = input.costMode as UsageCostMode;
        // Source-member and broker-Machine identities are administration
        // knowledge. Normal resource detail hides the broker from members, so
        // usage cannot become a side channel that reveals it.
        const authorizedBreakdown = !auth.manager
            && (input.breakdown === 'source_member' || input.breakdown === 'broker_machine')
            ? undefined
            : input.breakdown;
        const needsReadableSessions = authorizedBreakdown === 'session'
            || (authorizedBreakdown === 'worker_machine' && !auth.manager);
        const readableSessionIds = new Set<string>();
        if (needsReadableSessions) {
            const access = await resolveEffectiveSessionAccessWhere({
                mode: 'effective_access_v1', tx, accountId, capability: 'readTranscript',
                authentication: {
                    env: authentication.env ?? process.env,
                    authority: authentication.authenticationAuthority,
                    authenticationEvidence: authentication.authenticationEvidence,
                },
            });
            const readable = (await Promise.all(resourceWheres.map(resourceWhere => tx.session.findMany({
                where: { AND: [{ usageEvents: { some: resourceWhere } }, access.where] },
                select: { id: true, ...SESSION_TRANSCRIPT_PUBLICATION_SELECT },
            })))).flat();
            for (const session of readable) {
                // The portable database predicate is deliberately broader than
                // publication admission; retain its canonical runtime guard.
                if (session.accountId === accountId || isSessionTranscriptShareable(session)) readableSessionIds.add(session.id);
            }
        }
        const totals = aggregate(totalContributions, costMode);
        const rankedBreakdown = authorizedBreakdown
            ? Array.from(totalContributions.reduce((groups, row) => {
                const key = breakdownKey(row, authorizedBreakdown, { manager: auth.manager, readableSessionIds }) ?? 'unknown';
                const current = groups.get(key) ?? [];
                current.push(row);
                groups.set(key, current);
                return groups;
            }, new Map<string, ScopedUsageContribution[]>()).entries())
                .map(([key, group]) => ({ key, totals: aggregate(group, costMode) }))
                .sort((left, right) => right.totals.tokens.total - left.totals.tokens.total
                    || right.totals.requestCount - left.totals.requestCount
                    || left.key.localeCompare(right.key))
            : undefined;
        const cursorQueryKey = usageBreakdownCursorQueryKey(input);
        const decodedCursor = input.cursor ? decodeTeamKeysetCursorV1(input.cursor, cursorQueryKey) : null;
        const afterAnchor = decodedCursor?.status === 'ok' ? readTeamKeysetTextV1(decodedCursor.parts[0]) : null;
        if (input.cursor && (decodedCursor?.status !== 'ok' || afterAnchor === null)) {
            return { ok: false as const, error: 'invalid_resource_input' as const };
        }
        const pageStart = afterAnchor === null || !rankedBreakdown
            ? 0
            : rankedBreakdown.findIndex((entry) => usageBreakdownCursorAnchor(entry.key) === afterAnchor) + 1;
        if (afterAnchor !== null && (!rankedBreakdown || pageStart === 0)) {
            return { ok: false as const, error: 'invalid_resource_input' as const };
        }
        const grouped = rankedBreakdown?.slice(pageStart, pageStart + 50);
        const lastBreakdown = grouped?.[grouped.length - 1];
        const nextCursor = rankedBreakdown && pageStart + 50 < rankedBreakdown.length && lastBreakdown
            ? encodeTeamKeysetCursorV1({ queryKey: cursorQueryKey, parts: [usageBreakdownCursorAnchor(lastBreakdown.key)] })
            : null;
        const breakdownLabels = grouped && authorizedBreakdown
            ? await resolveBreakdownLabelsInTx(tx, {
                dimension: authorizedBreakdown,
                keys: grouped.map((entry) => entry.key),
                resourceId: input.resourceId,
            })
            : null;
        const coverage = projectTeamCredentialUsageCoverage(rows.map(toScopedUsageEventRow), {
            directUsePossible: auth.directUsePossible,
        });
        const resourceId = input.resourceId;
        const serializedLimits = resourceId === undefined ? [] : await (async () => {
            const limits = await tx.teamCredentialUsageLimit.findMany({ where: { resourceId, ...(auth.manager ? {} : { enabled: true }) }, orderBy: { createdAt: 'asc' } });
            const visibleLimits = auth.manager ? limits : await (async () => {
                const groupIds = new Set(await resolveEffectiveTeamGroupIdsForAccountInTx(tx, {
                    teamId: auth.resource.teamId,
                    accountId,
                }));
                return limits.filter((limit) => limit.subjectKind === 'resource'
                    || limit.subjectKind === 'each_member'
                    || (limit.subjectKind === 'team_member' && limit.subjectId === accountId)
                    || (limit.subjectKind === 'team_group' && groupIds.has(limit.subjectId)));
            })();
            const typedVisibleLimits: readonly TeamCredentialUsageLimitRow[] = visibleLimits.map((limit) => ({
                ...limit,
                subjectKind: TeamCredentialUsageLimitSubjectKindV1Schema.parse(limit.subjectKind),
                period: TeamCredentialUsageLimitPeriodV1Schema.parse(limit.period),
                metric: TeamCredentialUsageLimitMetricV1Schema.parse(limit.metric),
            }));
            const limitEvaluation = await projectTeamCredentialUsageLimitsInTx(tx, {
                resourceId,
                actorAccountId: accountId,
                limits: typedVisibleLimits,
            });
            if (!limitEvaluation.ok && 'unavailable' in limitEvaluation) {
                return { ok: false as const, error: 'cost_limit_unavailable' as const };
            }
            const limitDecisions = new Map(limitEvaluation.applied.map((decision) => [decision.limitId, decision]));
            return typedVisibleLimits.map((limit) => {
                const decision = limitDecisions.get(limit.id);
                if (!decision) throw new Error(`Team credential usage limit was not projected: ${limit.id}`);
                return {
                    id: limit.id, subjectKind: limit.subjectKind, subjectId: limit.subjectId, period: limit.period,
                    metric: limit.metric, maximum: limit.maximum, enabled: limit.enabled,
                    currentWindow: { recorded: String(decision.recorded), resetsAtUtc: decision.resetsAt.toISOString() },
                };
            });
        })();
        if (!Array.isArray(serializedLimits)) return serializedLimits;
        return TeamCredentialUsageQueryResultV1Schema.parse({
            v: 1 as const,
            totals,
            coverage,
            series: buildSeries(totalContributions, input.granularity, costMode),
            breakdown: grouped?.map((entry) => {
                const label = breakdownLabels?.get(entry.key);
                return label === undefined ? entry : { ...entry, label };
            }),
            nextCursor,
            limits: serializedLimits,
        });
    });
}
