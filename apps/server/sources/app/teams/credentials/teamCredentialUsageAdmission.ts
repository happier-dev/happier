import type { Tx } from '@/storage/inTx';
import {
    recordTeamCredentialAdmissionUsageEventInTx,
    resolveExistingTeamCredentialAdmissionUsageEventInTx,
    type TeamCredentialUsageWriteAuthority,
} from '@/app/usage/usageWriteService';
import {
    evaluateTeamCredentialUsageAdmissionLimitsInTx,
    type TeamCredentialUsageLimitDecision,
} from './teamCredentialUsageLimits';
import {
    resolveCurrentTeamCredentialUsageCapabilitiesForRoute,
    type TeamCredentialUsageRouteId,
} from './usageCapabilities';
import type { TeamCredentialUsageLimitDenialV1 } from '@happier-dev/protocol/teams';

export type TeamCredentialUsageAdmissionResult =
    | Readonly<{
        ok: true;
        usageEventId: string;
        created: boolean;
        appliedLimits: readonly TeamCredentialUsageLimitDecision[];
        budgetGroupIds: readonly string[];
    }>
    | Readonly<{
        ok: false;
        reasonCode: 'team_credential_usage_limit';
        denied: TeamCredentialUsageLimitDecision;
        usageLimit: TeamCredentialUsageLimitDenialV1;
    }>
    | Readonly<{
        ok: false;
        reasonCode: 'token_limit_unavailable';
        limitId: string;
    }>
    | Readonly<{
        ok: false;
        reasonCode: 'cost_limit_unavailable';
        limitId: string;
    }>;

/**
 * The one atomic recorded-usage admission effect. The caller establishes
 * authority or confirms that the admitted operation is still active in the
 * same transaction. This owner evaluates recorded ceilings and creates the
 * immutable request fact plus any external-key last-used update.
 *
 * Every admitted request on every `usageRoute` is accounted here, including
 * non-generation work such as token counting: callers do not decide whether a
 * route is billable. Whether a terminal token fact later follows is a property
 * of the route's producer, not of this admission.
 */
export async function admitTeamCredentialUsageInTx(
    tx: Tx,
    input: Readonly<{
        storageAccountId: string;
        sessionId: string | null;
        turnId: string | null;
        observedAt: Date;
        requestId: string;
        modelId: string | null;
        usageRoute: TeamCredentialUsageRouteId;
        authority: Omit<
            Extract<TeamCredentialUsageWriteAuthority, { kind: 'teamCredentialAdmission' }>,
            'groupIds'
        >;
    }>,
): Promise<TeamCredentialUsageAdmissionResult> {
    const existing = await resolveExistingTeamCredentialAdmissionUsageEventInTx(tx, {
        accountId: input.storageAccountId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        externalKey: input.requestId,
        modelId: input.modelId,
        authority: input.authority,
    });
    if (existing) {
        return {
            ok: true,
            usageEventId: existing.id,
            created: false,
            appliedLimits: [],
            budgetGroupIds: existing.groupIds,
        };
    }
    const limits = await evaluateTeamCredentialUsageAdmissionLimitsInTx(tx, {
        resourceId: input.authority.resourceId,
        actorAccountId: input.authority.requestingAccountId,
        now: input.observedAt,
    });
    const routeCapabilities = resolveCurrentTeamCredentialUsageCapabilitiesForRoute(input.usageRoute);
    const applied = limits.ok || 'denied' in limits ? limits.applied : [];
    const tokenLimit = applied.find((limit) => limit.metric === 'total_tokens');
    if (tokenLimit && routeCapabilities.totalTokens !== 'available') {
        return { ok: false, reasonCode: 'token_limit_unavailable', limitId: tokenLimit.limitId };
    }
    const costLimit = applied.find((limit) => limit.metric === 'cost_usd');
    if (costLimit && routeCapabilities.costUsd !== 'available') {
        return { ok: false, reasonCode: 'cost_limit_unavailable', limitId: costLimit.limitId };
    }
    if (!limits.ok) {
        if ('unavailable' in limits) {
            return { ok: false, reasonCode: 'cost_limit_unavailable', limitId: limits.unavailable.limitId };
        }
        return {
            ok: false,
            reasonCode: 'team_credential_usage_limit',
            denied: limits.denied,
            usageLimit: {
                metric: limits.denied.metric,
                remaining: '0',
                resetsAtUtc: limits.denied.resetsAt.toISOString(),
            },
        };
    }
    const usage = await recordTeamCredentialAdmissionUsageEventInTx(tx, {
        accountId: input.storageAccountId,
        sessionId: input.sessionId,
        turnId: input.turnId,
        observedAt: input.observedAt,
        externalKey: input.requestId,
        modelId: input.modelId,
        authority: { ...input.authority, groupIds: limits.budgetGroupIds },
    });
    return {
        ok: true,
        usageEventId: usage.id,
        created: usage.created,
        appliedLimits: limits.applied,
        budgetGroupIds: limits.budgetGroupIds,
    };
}
