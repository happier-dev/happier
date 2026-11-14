import { deleteTeamCredentialUsageCountersInTx } from './teamCredentialUsageCounters';
import {
    TeamCredentialUsageLimitDeleteInputV1Schema,
    TeamCredentialUsageLimitListInputV1Schema,
    TeamCredentialUsageLimitUpsertInputV1Schema,
    TeamCredentialUsageLimitSubjectKindV1Schema,
    TeamCredentialUsageLimitPeriodV1Schema,
    TeamCredentialUsageLimitMetricV1Schema,
    decodeTeamKeysetCursorV1,
    encodeTeamKeysetCursorV1,
    readTeamKeysetIdV1,
    readTeamKeysetTimeV1,
    type TeamCredentialUsageLimitV1,
    type TeamCredentialUsageLimitUpsertInputV1,
    type TeamCredentialUsageCapabilitiesV1,
} from '@happier-dev/protocol/teams';
import type { Tx } from '@/storage/inTx';
import { acquireTeamMutationAccountAdmissionInTx } from '../memberships/sessionAccessEffects';
import type { Prisma } from '@prisma/client';
import { AccountStatus } from '@/storage/enums.generated';
import { resolveEffectiveTeamGroupIdsForAccountInTx } from '../groups/effectiveGroupMembership';
import { resolveTeamActorContextInTx, type TeamOperationAuthenticationContext } from '../actorContext';
import { resolveTeamCredentialCapabilities } from '../capabilities';
import { publishTeamChangedInTx } from '../teamChanges';
import { recordTeamCredentialResourceActivityInTx } from './resourceActivity';
import { canonicalUsageLimitMaximum, projectTeamCredentialUsageLimitsInTx, type TeamCredentialUsageLimitRow } from './teamCredentialUsageLimits';
import { resolveTeamCredentialEntitlementInTx } from './resourceAccess';
import { qualifyTeamCredentialOperationInTx } from './resourceRead';
import { resolveCurrentTeamCredentialUsageCapabilitiesForResource } from './usageCapabilities';
import { admitTeamCredentialWithdrawalInTx } from './resourceWithdrawalAdmission';
import { readTeamCredentialResourceDisplayNameStored } from './privateLabels';

type LimitError = 'invalid_limit' | 'not_found_or_not_visible' | 'forbidden' | 'resource_changed'
    | 'limit_identity_immutable' | 'subject_not_in_team' | 'token_limit_unavailable' | 'cost_limit_unavailable'
    | 'resource_corrupt' | 'team_authentication_required' | 'team_authentication_policy_unavailable';

async function resolveManagerResourceInTx(
    tx: Tx,
    actorAccountId: string,
    resourceId: string,
    authentication: TeamOperationAuthenticationContext,
) {
    const resource = await tx.teamCredentialResource.findUnique({ where: { id: resourceId } });
    if (!resource) return { ok: false as const, error: 'not_found_or_not_visible' as const };
    const displayName = readTeamCredentialResourceDisplayNameStored(resource.displayName);
    if (displayName === null) return { ok: false as const, error: 'resource_corrupt' as const };
    const actor = await resolveTeamActorContextInTx(tx, { teamId: resource.teamId, actorAccountId });
    if (!actor) return { ok: false as const, error: 'not_found_or_not_visible' as const };
    if (actor.accountStatus !== AccountStatus.active) return { ok: false as const, error: 'forbidden' as const };
    const caps = resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt });
    if (!caps.manageCredentials) return { ok: false as const, error: 'forbidden' as const };
    const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, authentication);
    if (!qualification.ok) return qualification;
    return { ok: true as const, resource, displayName };
}

async function resolveReadableResourceInTx(
    tx: Tx,
    actorAccountId: string,
    resourceId: string,
    authentication: TeamOperationAuthenticationContext,
) {
    const resource = await tx.teamCredentialResource.findUnique({ where: { id: resourceId } });
    if (!resource) return { ok: false as const, error: 'not_found_or_not_visible' as const };
    const actor = await resolveTeamActorContextInTx(tx, { teamId: resource.teamId, actorAccountId });
    if (!actor || actor.accountStatus !== AccountStatus.active) {
        return { ok: false as const, error: 'not_found_or_not_visible' as const };
    }
    const caps = resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt });
    if (resource.custodianAccountId === actorAccountId) {
        const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, authentication);
        if (!qualification.ok) return qualification;
        return { ok: true as const, resource, manager: true as const, membershipId: actor.membership?.id ?? null };
    }
    if (caps.manageCredentials) {
        const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, authentication);
        if (!qualification.ok) return qualification;
        return { ok: true as const, resource, manager: true as const, membershipId: actor.membership?.id ?? null };
    }
    const entitlement = await resolveTeamCredentialEntitlementInTx(tx, { resourceId, accountId: actorAccountId });
    if (!entitlement.ok || !actor.membership) {
        return { ok: false as const, error: 'not_found_or_not_visible' as const };
    }
    const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, authentication);
    if (!qualification.ok) return qualification;
    return { ok: true as const, resource, manager: false as const, membershipId: actor.membership.id };
}

async function validateSubjectInTx(tx: Tx, resource: { teamId: string }, limit: TeamCredentialUsageLimitUpsertInputV1['limit']): Promise<LimitError | null> {
    if (limit.subjectKind === 'team_group') {
        const group = await tx.teamGroup.findFirst({ where: { id: limit.subjectId, teamId: resource.teamId }, select: { id: true } });
        return group ? null : 'subject_not_in_team';
    }
    if (limit.subjectKind === 'team_member') {
        const member = await tx.teamMembership.findUnique({
            where: { teamId_accountId: { teamId: resource.teamId, accountId: limit.subjectId } },
            select: { id: true },
        });
        return member ? null : 'subject_not_in_team';
    }
    return null;
}

export async function validateTeamCredentialUsageLimitDraftInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        limit: TeamCredentialUsageLimitUpsertInputV1['limit'];
        usageCapabilities?: TeamCredentialUsageCapabilitiesV1;
    }>,
): Promise<Readonly<{ ok: true; maximum: string }> | Readonly<{ ok: false; error: LimitError }>> {
    if (!input.usageCapabilities || input.usageCapabilities.limitCoverage !== 'brokered_only') {
        return { ok: false, error: 'invalid_limit' };
    }
    if (input.limit.metric === 'total_tokens'
        && input.usageCapabilities.totalTokens !== 'available') {
        return { ok: false, error: 'token_limit_unavailable' };
    }
    if (input.limit.metric === 'cost_usd'
        && input.usageCapabilities.costUsd !== 'available') {
        return { ok: false, error: 'cost_limit_unavailable' };
    }
    const subjectError = await validateSubjectInTx(tx, { teamId: input.teamId }, input.limit);
    if (subjectError) return { ok: false, error: subjectError };
    const maximum = canonicalUsageLimitMaximum(input.limit.maximum, input.limit.metric);
    return maximum === null ? { ok: false, error: 'invalid_limit' } : { ok: true, maximum };
}

function limitsCursorQueryKey(resourceId: string, actorAccountId: string): string {
    return `team-credential-limits:v1:${resourceId}:${actorAccountId}`;
}

function parseLimitRow(row: {
    id: string; resourceId: string; subjectKind: string; subjectId: string; period: string; metric: string;
    maximum: string; enabled: boolean; createdAt: Date;
}): TeamCredentialUsageLimitRow {
    return {
        id: row.id,
        resourceId: row.resourceId,
        subjectKind: TeamCredentialUsageLimitSubjectKindV1Schema.parse(row.subjectKind) as TeamCredentialUsageLimitV1['subjectKind'],
        subjectId: row.subjectId,
        period: TeamCredentialUsageLimitPeriodV1Schema.parse(row.period) as TeamCredentialUsageLimitV1['period'],
        metric: TeamCredentialUsageLimitMetricV1Schema.parse(row.metric) as TeamCredentialUsageLimitV1['metric'],
        maximum: row.maximum,
        enabled: row.enabled,
        createdAt: row.createdAt,
    };
}

function projectLimit(row: TeamCredentialUsageLimitRow, recorded: number, resetsAt: Date): TeamCredentialUsageLimitV1 {
    return {
        id: row.id, subjectKind: row.subjectKind, subjectId: row.subjectId, period: row.period,
        metric: row.metric, maximum: row.maximum, enabled: row.enabled,
        currentWindow: { recorded: String(recorded), resetsAtUtc: resetsAt.toISOString() },
    };
}

export async function listTeamCredentialUsageLimitsInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; resourceId: string; cursor?: string; limit?: number; authentication: TeamOperationAuthenticationContext }>,
) {
    const parsed = TeamCredentialUsageLimitListInputV1Schema.safeParse({
        resourceId: input.resourceId, cursor: input.cursor, limit: input.limit,
    });
    if (!parsed.success) return { ok: false as const, error: 'invalid_limit' as const };
    const auth = await resolveReadableResourceInTx(tx, input.actorAccountId, input.resourceId, input.authentication);
    if (!auth.ok) return auth;
    const queryKey = limitsCursorQueryKey(input.resourceId, input.actorAccountId);
    const decoded = parsed.data.cursor ? decodeTeamKeysetCursorV1(parsed.data.cursor, queryKey) : null;
    const afterCreatedAt = decoded?.status === 'ok' ? readTeamKeysetTimeV1(decoded.parts[0]) : null;
    const afterId = decoded?.status === 'ok' ? readTeamKeysetIdV1(decoded.parts[1]) : null;
    if (parsed.data.cursor && (decoded?.status !== 'ok' || afterCreatedAt === null || afterId === null)) {
        return { ok: false as const, error: 'invalid_limit' as const };
    }
    const groupIds = await resolveEffectiveTeamGroupIdsForAccountInTx(tx, {
        teamId: auth.resource.teamId,
        accountId: input.actorAccountId,
    });
    const visibleWhere: Prisma.TeamCredentialUsageLimitWhereInput = auth.manager ? {} : {
        enabled: true,
        OR: [
            { subjectKind: 'resource' },
            { subjectKind: 'each_member' },
            { subjectKind: 'team_member', subjectId: input.actorAccountId },
            ...(groupIds.length > 0 ? [{ subjectKind: 'team_group', subjectId: { in: [...groupIds] } }] : []),
        ],
    };
    const rows = await tx.teamCredentialUsageLimit.findMany({
        where: {
            resourceId: input.resourceId,
            ...visibleWhere,
            ...(afterCreatedAt !== null && afterId !== null ? {
                AND: [{
                    OR: [
                        { createdAt: { gt: new Date(afterCreatedAt) } },
                        { createdAt: new Date(afterCreatedAt), id: { gt: afterId } },
                    ],
                }],
            } : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: parsed.data.limit + 1,
    });
    const page = rows.slice(0, parsed.data.limit);
    const parsedRows = page.map(parseLimitRow);
    const usageCapabilities = resolveCurrentTeamCredentialUsageCapabilitiesForResource({
        allMembersDeliveryMode: auth.resource.allMembersDeliveryMode,
        groupGrants: await tx.teamCredentialGroupGrant.findMany({
            where: { resourceId: auth.resource.id }, select: { deliveryMode: true },
        }),
        memberGrants: await tx.teamCredentialMemberGrant.findMany({
            where: { resourceId: auth.resource.id }, select: { deliveryMode: true },
        }),
        sessionUsePolicy: auth.resource.sessionUsePolicy,
    });
    if (parsedRows.some((row) => row.metric === 'total_tokens')
        && usageCapabilities.totalTokens !== 'available') {
        return { ok: false as const, error: 'token_limit_unavailable' as const };
    }
    const evaluation = await projectTeamCredentialUsageLimitsInTx(tx, {
        resourceId: input.resourceId, actorAccountId: input.actorAccountId, limits: parsedRows,
    });
    if (!evaluation.ok && 'unavailable' in evaluation) {
        return { ok: false as const, error: 'cost_limit_unavailable' as const };
    }
    const decisions = new Map(evaluation.applied.map((decision) => [decision.limitId, decision]));
    const limits = parsedRows.map((row) => {
        const decision = decisions.get(row.id);
        if (!decision) throw new Error(`Team credential usage limit was not projected: ${row.id}`);
        return projectLimit(row, decision.recorded, decision.resetsAt);
    });
    const last = page[page.length - 1];
    const nextCursor = rows.length > parsed.data.limit && last
        ? encodeTeamKeysetCursorV1({ queryKey, parts: [last.createdAt.getTime(), last.id] })
        : null;
    return { ok: true as const, limits, nextCursor };
}

export async function upsertTeamCredentialUsageLimitInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; body: unknown; authentication: TeamOperationAuthenticationContext }>,
): Promise<Readonly<{ ok: true; resourceId: string; revision: number; limit: ReturnType<typeof projectLimit> } | { ok: false; error: LimitError }>> {
    const parsed = TeamCredentialUsageLimitUpsertInputV1Schema.safeParse(input.body);
    if (!parsed.success) return { ok: false, error: 'invalid_limit' };
    const body = parsed.data;
    const resourceIdentity = await tx.teamCredentialResource.findUnique({ where: { id: body.resourceId }, select: { teamId: true } });
    if (resourceIdentity) await acquireTeamMutationAccountAdmissionInTx(tx, { teamId: resourceIdentity.teamId,
        accountIds: [input.actorAccountId, ...(body.limit.subjectKind === 'team_member' ? [body.limit.subjectId] : [])] });
    const auth = await resolveManagerResourceInTx(tx, input.actorAccountId, body.resourceId, input.authentication);
    if (!auth.ok) return auth;
    if (auth.resource.revision !== body.expectedRevision) return { ok: false, error: 'resource_changed' };
    const validated = await validateTeamCredentialUsageLimitDraftInTx(tx, {
        teamId: auth.resource.teamId,
        limit: body.limit,
        usageCapabilities: resolveCurrentTeamCredentialUsageCapabilitiesForResource({
            allMembersDeliveryMode: auth.resource.allMembersDeliveryMode,
            groupGrants: await tx.teamCredentialGroupGrant.findMany({
                where: { resourceId: auth.resource.id }, select: { deliveryMode: true },
            }),
            memberGrants: await tx.teamCredentialMemberGrant.findMany({
                where: { resourceId: auth.resource.id }, select: { deliveryMode: true },
            }),
            sessionUsePolicy: auth.resource.sessionUsePolicy,
        }),
    });
    if (!validated.ok) return validated;
    const maximum = validated.maximum;
    const existing = body.limit.id
        ? await tx.teamCredentialUsageLimit.findUnique({ where: { id: body.limit.id } })
        : await tx.teamCredentialUsageLimit.findUnique({ where: {
            resourceId_subjectKind_subjectId_period_metric: {
                resourceId: auth.resource.id,
                subjectKind: body.limit.subjectKind,
                subjectId: body.limit.subjectId,
                period: body.limit.period,
                metric: body.limit.metric,
            },
        } });
    if (existing && existing.resourceId !== auth.resource.id) return { ok: false, error: 'not_found_or_not_visible' };
    if (existing && (existing.subjectKind !== body.limit.subjectKind || existing.subjectId !== body.limit.subjectId
        || existing.period !== body.limit.period || existing.metric !== body.limit.metric)) {
        return { ok: false, error: 'limit_identity_immutable' };
    }
    const updated = await tx.teamCredentialResource.updateMany({
        where: { id: auth.resource.id, revision: body.expectedRevision },
        data: { revision: { increment: 1 } },
    });
    if (updated.count !== 1) return { ok: false, error: 'resource_changed' };
    const row = existing
        ? await tx.teamCredentialUsageLimit.update({ where: { id: existing.id }, data: { maximum, enabled: body.limit.enabled } })
        : await tx.teamCredentialUsageLimit.create({ data: {
            resourceId: auth.resource.id, subjectKind: body.limit.subjectKind, subjectId: body.limit.subjectId,
            period: body.limit.period, metric: body.limit.metric, maximum, enabled: body.limit.enabled,
        } });
    await recordTeamCredentialResourceActivityInTx(tx, { teamId: auth.resource.teamId, resourceId: auth.resource.id, kind: 'limits_changed', actor: { kind: 'account', accountId: input.actorAccountId }, subjectDisplayName: auth.displayName });
    await publishTeamChangedInTx(tx, { teamId: auth.resource.teamId, additionalAccountIds: [auth.resource.custodianAccountId, input.actorAccountId] });
    const projection = await projectTeamCredentialUsageLimitsInTx(tx, {
        resourceId: auth.resource.id,
        actorAccountId: input.actorAccountId,
        limits: [parseLimitRow(row)],
    });
    if (!projection.ok && 'unavailable' in projection) {
        return { ok: false, error: 'cost_limit_unavailable' };
    }
    const decision = projection.applied.find((entry) => entry.limitId === row.id);
    if (!decision) throw new Error(`Team credential usage limit was not projected: ${row.id}`);
    return {
        ok: true,
        resourceId: auth.resource.id,
        revision: body.expectedRevision + 1,
        limit: projectLimit(parseLimitRow(row), decision.recorded, decision.resetsAt),
    };
}

export async function deleteTeamCredentialUsageLimitInTx(
    tx: Tx,
    input: Readonly<{ actorAccountId: string; body: unknown; authentication: TeamOperationAuthenticationContext }>,
): Promise<Readonly<{ ok: true; resourceId: string; revision: number } | { ok: false; error: LimitError }>> {
    const parsed = TeamCredentialUsageLimitDeleteInputV1Schema.safeParse(input.body);
    if (!parsed.success) return { ok: false, error: 'invalid_limit' };
    if (!await admitTeamCredentialWithdrawalInTx(tx, { actorAccountId: input.actorAccountId, resourceId: parsed.data.resourceId })) {
        return { ok: false, error: 'not_found_or_not_visible' };
    }
    const auth = await resolveManagerResourceInTx(tx, input.actorAccountId, parsed.data.resourceId, input.authentication);
    if (!auth.ok) return auth;
    if (auth.resource.revision !== parsed.data.expectedRevision) return { ok: false, error: 'resource_changed' };
    const row = await tx.teamCredentialUsageLimit.findUnique({ where: { id: parsed.data.limitId } });
    if (!row || row.resourceId !== auth.resource.id) return { ok: false, error: 'not_found_or_not_visible' };
    const updated = await tx.teamCredentialResource.updateMany({
        where: { id: auth.resource.id, revision: parsed.data.expectedRevision },
        data: { revision: { increment: 1 } },
    });
    if (updated.count !== 1) return { ok: false, error: 'resource_changed' };
    await tx.teamCredentialUsageLimit.delete({ where: { id: row.id } });
    await deleteTeamCredentialUsageCountersInTx(tx, auth.resource.custodianAccountId, row.id);
    await recordTeamCredentialResourceActivityInTx(tx, { teamId: auth.resource.teamId, resourceId: auth.resource.id, kind: 'limits_changed', actor: { kind: 'account', accountId: input.actorAccountId }, subjectDisplayName: auth.displayName });
    await publishTeamChangedInTx(tx, { teamId: auth.resource.teamId, additionalAccountIds: [auth.resource.custodianAccountId, input.actorAccountId] });
    return { ok: true, resourceId: auth.resource.id, revision: parsed.data.expectedRevision + 1 };
}
