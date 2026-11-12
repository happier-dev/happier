import { resolveEffectiveTeamGroupIdsForAccountInTx } from '@/app/teams/groups/effectiveGroupMembership';
import type { Tx } from '@/storage/inTx';
import {
    evaluateResourcesFromDatabaseInTx, loadTeamCredentialUsageAdmissionRequestsInTx, parseUsageLimitRows,
    type TeamCredentialUsageLimitDecision, type TeamCredentialUsageLimitEvaluation,
    type TeamCredentialUsageLimitInputRow, type TeamCredentialUsageLimitRow,
} from './teamCredentialUsageLimitEvaluation';
import { evaluateTeamCredentialUsageCountersInTx } from './teamCredentialUsageCounters';
export {
    canonicalUsageLimitMaximum, evaluateTeamCredentialUsageLimits,
    type TeamCredentialUsageLimitDecision, type TeamCredentialUsageLimitEvaluation,
    type TeamCredentialUsageLimitEvent, type TeamCredentialUsageLimitRow,
} from './teamCredentialUsageLimitEvaluation';

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

/** The live request owner reads period counters; first use reconstructs retained usage once. */
export async function evaluateTeamCredentialUsageAdmissionLimitsInTx(
    tx: Tx,
    input: Readonly<{ resourceId: string; actorAccountId: string; now?: Date }>,
): Promise<TeamCredentialUsageAdmissionLimitEvaluation> {
    const { requests, budgetGroupIdsByResourceId } = await loadTeamCredentialUsageAdmissionRequestsInTx(tx, {
        resourceIds: [input.resourceId], actorAccountId: input.actorAccountId,
    });
    const request = requests[0];
    if (!request) return { ok: true, applied: [], budgetGroupIds: [] };
    return {
        ...await evaluateTeamCredentialUsageCountersInTx(tx, { ...request, now: input.now ?? new Date() }),
        budgetGroupIds: budgetGroupIdsByResourceId.get(input.resourceId) ?? [],
    };
}

/** Catalog projections are advisory, read-only views of the same canonical recorded-usage rule. */
export async function evaluateTeamCredentialUsageAdmissionLimitsForResourcesInTx(
    tx: Tx,
    input: Readonly<{ resourceIds: readonly string[]; actorAccountId: string; now?: Date }>,
): Promise<Map<string, TeamCredentialUsageAdmissionLimitEvaluation>> {
    const { requests, budgetGroupIdsByResourceId } = await loadTeamCredentialUsageAdmissionRequestsInTx(tx, input);
    const evaluations = await evaluateResourcesFromDatabaseInTx(tx, { requests, now: input.now ?? new Date() });
    return new Map<string, TeamCredentialUsageAdmissionLimitEvaluation>(input.resourceIds.map(resourceId => [resourceId, {
        ...(evaluations.get(resourceId) ?? { ok: true, applied: [] }),
        budgetGroupIds: budgetGroupIdsByResourceId.get(resourceId) ?? [],
    }]));
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
