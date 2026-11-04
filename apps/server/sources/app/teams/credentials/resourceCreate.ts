import { isDeepStrictEqual } from "node:util";
import { readTeamCredentialSourceBinding } from './sourceBindingRead';
import { readTeamCredentialAudience, readTeamCredentialDeliveryConfiguration, serializeTeamCredentialAudience } from './resourceDeliveryRead';
import { TeamCredentialResourceCreateInputV1Schema, type TeamCredentialResourceCreateInputV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import type { Tx } from "@/storage/inTx";
import { acquireTeamMembershipAccountAdmissionInTx } from "../memberships/membershipService";
import { resolveTeamActorContextInTx, type TeamOperationAuthenticationContext } from "../actorContext";
import { resolveTeamCredentialCapabilities } from "../capabilities";
import { publishTeamChangedInTx } from "../teamChanges";
import { validateTeamCredentialAudienceDraftInTx } from "./resourceAudience";
import { recordTeamCredentialActivityInTx } from "./resourceActivity";
import { validateTeamCredentialUsageLimitDraftInTx } from "./resourceLimits";
import { canonicalUsageLimitMaximum } from "./teamCredentialUsageLimits";
import { resolveCurrentTeamCredentialUsageCapabilitiesForResource } from "./usageCapabilities";
import { qualifyTeamCredentialOperationInTx } from "./resourceRead";
import { resolveTeamCredentialResourceSourceInTx } from "./resourceSourceResolver";
import { readTeamCredentialBrokerPlacement, validateTeamCredentialBrokerPlacementForSaveInTx } from "./brokerPlacementResolver";
import {
    isTeamCredentialRequestPolicySupportEvidenceCurrent,
    normalizeTeamCredentialRequestPolicyForPersistence,
    type TeamCredentialRequestPolicySupportEvidence,
} from "./resourceRequestPolicySupport";

export interface CreateTeamCredentialResourceInput extends TeamCredentialResourceCreateInputV1 {
    actorAccountId: string;
    authentication: TeamOperationAuthenticationContext;
    requestPolicySupport?: TeamCredentialRequestPolicySupportEvidence;
}

export type CreateTeamCredentialResourceResult =
    | Readonly<{ ok: true; resourceId: string; revision: number }>
    | Readonly<{ ok: false; error: "forbidden" | "resource_changed" | "not_found_or_not_visible" | "invalid_resource_input" | "invalid_audience" | "disclosure_not_allowed" | "broker_unavailable" | "update_required" | "invalid_limit" | "subject_not_in_team" | "token_limit_unavailable" | "cost_limit_unavailable" | "source_owner_required" | "source_replaced_or_missing" | "team_authentication_required" | "team_authentication_policy_unavailable" }>;

async function existingMatchesDraft(tx: Tx, existing: NonNullable<Awaited<ReturnType<Tx['teamCredentialResource']['findUnique']>>>, body: TeamCredentialResourceCreateInputV1) {
    const storedSourceRead = readTeamCredentialSourceBinding(existing.sourceBindingJson);
    if (!storedSourceRead.success) return false;
    const storedSource = storedSourceRead.data;
    const [groups, members, limits] = await Promise.all([
        tx.teamCredentialGroupGrant.findMany({ where: { resourceId: existing.id }, select: { teamGroupId: true, deliveryMode: true } }),
        tx.teamCredentialMemberGrant.findMany({ where: { resourceId: existing.id }, select: { teamMembershipId: true, deliveryMode: true } }),
        tx.teamCredentialUsageLimit.findMany({ where: { resourceId: existing.id }, select: { subjectKind: true, subjectId: true, period: true, metric: true, maximum: true, enabled: true } }),
    ]);
    const placement = readTeamCredentialBrokerPlacement(existing);
    if (!placement.ok) return false;
    const storedAudience = readTeamCredentialAudience({ allMembersDeliveryMode: existing.allMembersDeliveryMode,
        groupGrants: groups, memberGrants: members });
    const configuration = readTeamCredentialDeliveryConfiguration(existing.disclosureCeiling);
    if (!storedAudience.success || !configuration.success) return false;
    const canonicalStoredAudience = serializeTeamCredentialAudience(storedAudience.data);
    const requestedAudience = serializeTeamCredentialAudience(body);
    const groupTuples = canonicalStoredAudience.groupGrants.map(row => [row.teamGroupId, row.deliveryMode]).sort();
    const requestedGroupTuples = requestedAudience.groupGrants.map(row => [row.teamGroupId, row.deliveryMode]).sort();
    const memberTuples = canonicalStoredAudience.memberGrants.map(row => [row.teamMembershipId, row.deliveryMode]).sort();
    const requestedMemberTuples = requestedAudience.memberGrants.map(row => [row.teamMembershipId, row.deliveryMode]).sort();
    const limitTuples = limits.map(row => [row.subjectKind, row.subjectId, row.period, row.metric, row.maximum, row.enabled]).sort();
    const requestedLimitTuples = body.usageLimits.map(row => [row.subjectKind, row.subjectId, row.period, row.metric, canonicalUsageLimitMaximum(row.maximum, row.metric), row.enabled]).sort();
    return existing.teamId === body.teamId && existing.displayName === body.displayName.trim()
        && isDeepStrictEqual(configuration.data.policy, body.deliveryPolicy) && existing.sessionUsePolicy === body.sessionUsePolicy
        && canonicalStoredAudience.allMembersDeliveryMode === requestedAudience.allMembersDeliveryMode && JSON.stringify(storedSource) === JSON.stringify(body.source)
        && isDeepStrictEqual(placement.placement, body.brokerPlacement)
        && existing.requestPolicyJson === (body.requestPolicy === null ? null : JSON.stringify(body.requestPolicy))
        && isDeepStrictEqual(groupTuples, requestedGroupTuples)
        && isDeepStrictEqual(memberTuples, requestedMemberTuples)
        && isDeepStrictEqual(limitTuples, requestedLimitTuples);
}

/** Creates the complete usable resource draft at one transaction boundary. */
export async function createTeamCredentialResourceInTx(tx: Tx, input: CreateTeamCredentialResourceInput): Promise<CreateTeamCredentialResourceResult> {
    const {
        actorAccountId: _actorAccountId,
        authentication: _authentication,
        requestPolicySupport: _requestPolicySupport,
        ...draft
    } = input;
    const parsed = TeamCredentialResourceCreateInputV1Schema.safeParse(draft);
    if (!parsed.success) return { ok: false, error: "invalid_resource_input" };
    const body = parsed.data;
    await acquireTeamMembershipAccountAdmissionInTx(tx, {
        teamId: body.teamId,
        intent: "exclusive",
        accountIds: [input.actorAccountId, ...body.usageLimits.flatMap(limit => limit.subjectKind === 'team_member' ? [limit.subjectId] : [])],
        membershipIds: body.memberGrants.map(grant => grant.teamMembershipId),
    });
    const actor = await resolveTeamActorContextInTx(tx, { teamId: body.teamId, actorAccountId: input.actorAccountId });
    if (!actor) return { ok: false, error: "not_found_or_not_visible" };
    const capabilities = resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt });
    if (!capabilities.offerOwnCredential) return { ok: false, error: "forbidden" };
    const configuresTeamPolicy = body.allMembersAllowedRoutes !== null || body.groupGrants.length > 0
        || body.memberGrants.length > 0 || body.sessionUsePolicy !== 'personal_allowed'
        || body.requestPolicy !== null || body.usageLimits.length > 0;
    if (configuresTeamPolicy && !capabilities.manageCredentials) return { ok: false, error: 'forbidden' };
    const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, input.authentication);
    if (!qualification.ok) return qualification;
    const existing = await tx.teamCredentialResource.findUnique({ where: { id: body.resourceId } });
    if (existing) {
        if (existing.teamId !== body.teamId || existing.custodianAccountId !== input.actorAccountId) return { ok: false, error: "not_found_or_not_visible" };
        return await existingMatchesDraft(tx, existing, body)
            ? { ok: true, resourceId: existing.id, revision: existing.revision }
            : { ok: false, error: "resource_changed" };
    }
    const source = await resolveTeamCredentialResourceSourceInTx(tx, { custodianAccountId: input.actorAccountId, source: body.source });
    if (source.status !== "current") return { ok: false, error: "source_replaced_or_missing" };
    const requestsDirect = [
        body.allMembersAllowedRoutes,
        ...body.groupGrants.map(grant => grant.allowedRoutes),
        ...body.memberGrants.map(grant => grant.allowedRoutes),
    ].some(routes => routes?.includes('direct'));
    if (requestsDirect && source.directExportSupport === "unsupported") {
        return { ok: false, error: "disclosure_not_allowed" };
    }
    const audience = await validateTeamCredentialAudienceDraftInTx(tx, {
        teamId: body.teamId, deliveryPolicy: body.deliveryPolicy,
        brokerPlacement: body.brokerPlacement, audience: body,
    });
    if (!audience.ok) return audience;
    const placement = await validateTeamCredentialBrokerPlacementForSaveInTx(tx, {
        custodianAccountId: input.actorAccountId,
        placement: body.brokerPlacement,
    });
    if (!placement.ok) return placement;
    const storedAudience = serializeTeamCredentialAudience(body);
    const limitRows: { subjectKind: string; subjectId: string; period: string; metric: string; maximum: string; enabled: boolean }[] = [];
    const identities = new Set<string>();
    for (const limit of body.usageLimits) {
        const identity = JSON.stringify([limit.subjectKind, limit.subjectId, limit.period, limit.metric]);
        if (identities.has(identity)) return { ok: false, error: 'invalid_limit' };
        identities.add(identity);
        const validated = await validateTeamCredentialUsageLimitDraftInTx(tx, {
            teamId: body.teamId,
            limit,
            usageCapabilities: resolveCurrentTeamCredentialUsageCapabilitiesForResource({
                ...storedAudience,
                sessionUsePolicy: body.sessionUsePolicy,
            }),
        });
        if (!validated.ok) {
            const error = validated.error === 'subject_not_in_team'
                || validated.error === 'token_limit_unavailable'
                || validated.error === 'cost_limit_unavailable'
                ? validated.error : 'invalid_limit';
            return { ok: false, error };
        }
        limitRows.push({ ...limit, maximum: validated.maximum });
    }
    const requestPolicy = body.requestPolicy === null
        ? null
        : input.requestPolicySupport
            && isTeamCredentialRequestPolicySupportEvidenceCurrent({
                evidence: input.requestPolicySupport,
                source: body.source,
                sourceCurrentness: source.requestPolicyCurrentness,
            })
            ? normalizeTeamCredentialRequestPolicyForPersistence({
                policy: body.requestPolicy,
                models: input.requestPolicySupport.models,
            })
            : null;
    if (body.requestPolicy !== null && requestPolicy === null) {
        return { ok: false, error: "update_required" };
    }
    const resource = await tx.teamCredentialResource.create({ data: {
        id: body.resourceId, teamId: body.teamId, custodianAccountId: input.actorAccountId,
        displayName: body.displayName.trim(), sourceBindingJson: JSON.stringify(body.source),
        disclosureCeiling: JSON.stringify({ policy: body.deliveryPolicy }),
        sessionUsePolicy: body.sessionUsePolicy, requestPolicyJson: requestPolicy === null ? null : JSON.stringify(requestPolicy),
        brokerMachineId: body.brokerPlacement?.kind === 'machine' ? body.brokerPlacement.machineId : null,
        brokerPoolId: body.brokerPlacement?.kind === 'machine_pool' ? body.brokerPlacement.poolId : null,
        allMembersDeliveryMode: storedAudience.allMembersDeliveryMode,
    } });
    if (storedAudience.groupGrants.length > 0) await tx.teamCredentialGroupGrant.createMany({ data: storedAudience.groupGrants.map(grant => ({ resourceId: resource.id, ...grant })) });
    if (storedAudience.memberGrants.length > 0) await tx.teamCredentialMemberGrant.createMany({ data: storedAudience.memberGrants.map(grant => ({ resourceId: resource.id, ...grant })) });
    if (limitRows.length > 0) await tx.teamCredentialUsageLimit.createMany({ data: limitRows.map(limit => ({ resourceId: resource.id, ...limit })) });
    await recordTeamCredentialActivityInTx(tx, { teamId: body.teamId, resourceId: resource.id, kind: "resource_created", actor: { kind: "account", accountId: input.actorAccountId }, subjectDisplayName: resource.displayName });
    await publishTeamChangedInTx(tx, { teamId: body.teamId, additionalAccountIds: [input.actorAccountId] });
    return { ok: true, resourceId: resource.id, revision: resource.revision };
}
