import { deleteTeamCredentialUsageCountersInTx } from './teamCredentialUsageCounters';
import { isDeepStrictEqual } from "node:util";
import { z } from 'zod/mini';
import { TeamCredentialDeliveryPolicyV1Schema, TeamCredentialSessionUsePolicyV1Schema, TeamCredentialRequestPolicyV1Schema, TeamCredentialBrokerPlacementV1Schema, TeamCredentialResourceReplacementV1Schema, TeamCredentialResourceUpdateInputV1Schema, type TeamCredentialDeliveryPolicyV1, type TeamCredentialResourceUpdateInputV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { readTeamCredentialSourceBinding } from './sourceBindingRead';
import { narrowTeamCredentialAudience, readTeamCredentialAudience, readTeamCredentialDeliveryConfiguration, serializeTeamCredentialAudience } from './resourceDeliveryRead';
import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { acquireTeamMembershipAccountAdmissionInTx } from "../memberships/membershipService";
import { AccountStatus } from "@/storage/enums.generated";
import { acquireTeamMutationLockInTx, resolveTeamActorContextInTx, type TeamOperationAuthenticationContext } from "../actorContext";
import { resolveTeamCredentialCapabilities } from "../capabilities";
import { publishTeamChangedInTx } from "../teamChanges";
import { publishNativeCredentialPolicyChangesInTx, readNativeCredentialPolicyPublicationAccountIdsInTx } from "./nativePolicyChanges";
import { recordTeamCredentialResourceActivityInTx } from "./resourceActivity";
import { readTeamCredentialBrokerPlacement, validateTeamCredentialBrokerPlacementForSaveInTx } from "./brokerPlacementResolver";
import { qualifyTeamCredentialOperationInTx } from "./resourceRead";
import { resolveTeamCredentialResourceSourceInTx } from "./resourceSourceResolver";
import { validateTeamCredentialAudienceDraftInTx } from "./resourceAudience";
import { retainEntitledTeamCredentialRecipientMaterialInTx } from "./recipientMaterial";
import { validateTeamCredentialUsageLimitDraftInTx } from "./resourceLimits";
import {
    findTeamCredentialUsageLimitCapabilityRefusal,
    resolveCurrentTeamCredentialUsageCapabilitiesForResource,
} from "./usageCapabilities";
import {
    isTeamCredentialRequestPolicySupportEvidenceCurrent,
    normalizeTeamCredentialRequestPolicyForPersistence,
    type TeamCredentialRequestPolicySupportEvidence,
} from "./resourceRequestPolicySupport";
import {
    prepareTeamCredentialResourceDisplayNameForWriteInTx,
    readTeamCredentialResourceDisplayNameStored,
} from './privateLabels';

export type UpdateTeamCredentialResourceInput = TeamCredentialResourceUpdateInputV1;

export type UpdateTeamCredentialResourceResult =
    | Readonly<{ ok: false; error: 'access_only_expiry_unavailable'; message?: string }>
    | Readonly<{ ok: true; resourceId: string; revision: number }>
    | Readonly<{ ok: false; error: "resource_not_found" | "resource_forbidden" | "resource_changed" | "invalid_resource_input" | "invalid_audience" | "invalid_limit" | "subject_not_in_team" | "token_limit_unavailable" | "cost_limit_unavailable" | "source_replaced_or_missing" | "disclosure_not_allowed" | "broker_unavailable" | "update_required" | "resource_corrupt" | "team_authentication_required" | "team_authentication_policy_unavailable" }>;

type TeamCredentialAuthorityRefusal = Readonly<{
    ok: false;
    error: "resource_forbidden" | "team_authentication_required" | "team_authentication_policy_unavailable";
}>;
type TeamCredentialAuthorityResult = Readonly<{ ok: true }> | TeamCredentialAuthorityRefusal;
type TeamCredentialActor = NonNullable<Awaited<ReturnType<typeof resolveTeamActorContextInTx>>>;

/**
 * A custodian's consent to expand or retarget their own credential (widen
 * route consent, select another source or broker location, run the saved test)
 * is current Team participation: the custodian may offer credentials in this
 * unarchived Team and satisfies its authentication policy.
 */
export async function authorizeTeamCredentialCustodianConsentInTx(
    tx: Tx,
    input: Readonly<{ teamId: string; actorAccountId: string; authentication: TeamOperationAuthenticationContext; actor?: TeamCredentialActor | null }>,
): Promise<TeamCredentialAuthorityResult> {
    const actor = input.actor !== undefined ? input.actor : await resolveTeamActorContextInTx(tx, {
        teamId: input.teamId,
        actorAccountId: input.actorAccountId,
    });
    if (actor === null || !resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt }).offerOwnCredential) {
        return { ok: false, error: "resource_forbidden" };
    }
    const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, input.authentication);
    return qualification.ok ? { ok: true } : qualification;
}

/**
 * The one update authority decision shared by patch and replacement.
 *
 * Withdrawal (disabling the resource or narrowing route consent) stays
 * available to the active source custodian even after they leave the Team, so
 * they can always take their own credential out of service. Every expanding or
 * retargeting custodian change needs current custodian consent, and every
 * manager-owned change needs a qualified Team manager. Only an active custodian
 * or a qualified manager is admitted to read stored row state.
 */
async function resolveTeamCredentialUpdateAuthorityInTx(
    tx: Tx,
    input: Readonly<{
        resource: Readonly<{ teamId: string; custodianAccountId: string }>;
        actorAccountId: string;
        authentication: TeamOperationAuthenticationContext;
    }>,
) {
    const actor = await resolveTeamActorContextInTx(tx, {
        teamId: input.resource.teamId,
        actorAccountId: input.actorAccountId,
    });
    const canManageStructurally = actor !== null
        && resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt }).manageCredentials;
    const isCustodian = input.resource.custodianAccountId === input.actorAccountId;
    const custodianAccount = isCustodian
        ? await tx.account.findUnique({ where: { id: input.actorAccountId }, select: { status: true } })
        : null;
    const isActiveCustodian = custodianAccount?.status === AccountStatus.active;
    let manager: Promise<TeamCredentialAuthorityResult> | undefined;
    let consent: Promise<TeamCredentialAuthorityResult> | undefined;
    const requireManager = (): Promise<TeamCredentialAuthorityResult> => manager ??= actor === null || !canManageStructurally
        ? Promise.resolve({ ok: false, error: "resource_forbidden" })
        : qualifyTeamCredentialOperationInTx(tx, actor, input.authentication)
            .then((result): TeamCredentialAuthorityResult => result.ok ? { ok: true } : result);
    const requireCustodianConsent = (): Promise<TeamCredentialAuthorityResult> => consent ??= !isActiveCustodian
        ? Promise.resolve({ ok: false, error: "resource_forbidden" })
        : authorizeTeamCredentialCustodianConsentInTx(tx, {
            teamId: input.resource.teamId,
            actorAccountId: input.actorAccountId,
            authentication: input.authentication,
            actor,
        });
    const requireWithdrawal = (): Promise<TeamCredentialAuthorityResult> => isActiveCustodian
        ? Promise.resolve({ ok: true })
        : requireManager();
    if (!canManageStructurally && !isActiveCustodian) {
        return { ok: false as const, error: "resource_forbidden" as const };
    }
    // An actor admitted only as a manager qualifies before any stored-row
    // state is disclosed; the active custodian may read its own resource.
    if (!isActiveCustodian) {
        const qualified = await requireManager();
        if (!qualified.ok) return qualified;
    }
    return { ok: true as const, isCustodian, requireManager, requireCustodianConsent, requireWithdrawal };
}

/** Keeping or removing routes in their stored order withdraws; adding or reordering is consent. */
function withdrawsRouteConsent(
    stored: TeamCredentialDeliveryPolicyV1,
    next: TeamCredentialDeliveryPolicyV1,
): boolean {
    const kept = stored.preferredAllowedModes.filter(route => next.preferredAllowedModes.includes(route));
    return isDeepStrictEqual(kept, next.preferredAllowedModes);
}

function parseJson(value: string | null): unknown {
    if (value === null) return null;
    try { return JSON.parse(value) as unknown; } catch { return undefined; }
}

function sortedAudience<T extends { deliveryMode: string }>(rows: readonly T[], id: keyof T): readonly (readonly string[])[] {
    return rows.map((row) => [String(row[id]), row.deliveryMode] as const)
        .sort(([left], [right]) => left.localeCompare(right));
}

async function applyResourceReplacementInTx(
    tx: Tx,
    input: Readonly<{
        actorAccountId: string;
        authentication: TeamOperationAuthenticationContext;
        resource: NonNullable<Awaited<ReturnType<Tx["teamCredentialResource"]["findUnique"]>>>;
        expectedRevision: number;
        replacement: NonNullable<TeamCredentialResourceUpdateInputV1['replacement']>;
        requestPolicySupport?: TeamCredentialRequestPolicySupportEvidence;
    }>,
): Promise<UpdateTeamCredentialResourceResult> {
    const resource = input.resource;
    const authority = await resolveTeamCredentialUpdateAuthorityInTx(tx, {
        resource,
        actorAccountId: input.actorAccountId,
        authentication: input.authentication,
    });
    if (!authority.ok) return authority;
    if (resource.revision !== input.expectedRevision) return { ok: false, error: "resource_changed" };

    const storedSource = readTeamCredentialSourceBinding(resource.sourceBindingJson);
    const storedPolicy = parseJson(resource.requestPolicyJson);
    const storedDelivery = readTeamCredentialDeliveryConfiguration(resource.disclosureCeiling);
    const storedSessionPolicy = TeamCredentialSessionUsePolicyV1Schema.safeParse(resource.sessionUsePolicy);
    const storedRequestPolicy = z.nullable(TeamCredentialRequestPolicyV1Schema).safeParse(storedPolicy);
    const storedPlacement = readTeamCredentialBrokerPlacement(resource);
    const storedDisplayName = readTeamCredentialResourceDisplayNameStored(resource.displayName);
    if (!storedSource.success || !storedDelivery.success || !storedSessionPolicy.success
        || !storedRequestPolicy.success || !storedPlacement.ok || storedDisplayName === null) {
        return { ok: false, error: "resource_corrupt" };
    }

    const [currentGroups, currentMembers, currentLimits] = await Promise.all([
        tx.teamCredentialGroupGrant.findMany({
            where: { resourceId: resource.id },
            select: { teamGroupId: true, deliveryMode: true },
        }),
        tx.teamCredentialMemberGrant.findMany({
            where: { resourceId: resource.id },
            select: { teamMembershipId: true, deliveryMode: true },
        }),
        tx.teamCredentialUsageLimit.findMany({ where: { resourceId: resource.id } }),
    ]);
    const currentAudience = readTeamCredentialAudience({ allMembersDeliveryMode: resource.allMembersDeliveryMode,
        groupGrants: currentGroups, memberGrants: currentMembers });
    if (!currentAudience.success) return { ok: false, error: "resource_corrupt" };
    const storedCurrentAudience = serializeTeamCredentialAudience(currentAudience.data);
    // The public summary masks manager-owned fields for custodians. Complete
    // omitted fields from locked storage, never from those presentation values.
    const parsedReplacement = TeamCredentialResourceReplacementV1Schema.safeParse({
        enabled: input.replacement.enabled ?? resource.enabled,
        displayName: input.replacement.displayName ?? storedDisplayName,
        sessionUsePolicy: input.replacement.sessionUsePolicy ?? storedSessionPolicy.data,
        requestPolicy: input.replacement.requestPolicy === undefined ? storedRequestPolicy.data : input.replacement.requestPolicy,
        allMembersAllowedRoutes: input.replacement.allMembersAllowedRoutes === undefined
            ? currentAudience.data.allMembersAllowedRoutes : input.replacement.allMembersAllowedRoutes,
        groupGrants: input.replacement.groupGrants ?? currentAudience.data.groupGrants,
        memberGrants: input.replacement.memberGrants ?? currentAudience.data.memberGrants,
        usageLimitDelta: input.replacement.usageLimitDelta ?? { upserts: [], deleteIds: [] },
        custodian: input.replacement.custodian,
    });
    if (!parsedReplacement.success) return { ok: false, error: "resource_corrupt" };
    const replacement = parsedReplacement.data;
    const requestedAudience = serializeTeamCredentialAudience(replacement);
    const audienceChanged = storedCurrentAudience.allMembersDeliveryMode !== requestedAudience.allMembersDeliveryMode
        || !isDeepStrictEqual(
            sortedAudience(storedCurrentAudience.groupGrants, "teamGroupId"),
            sortedAudience(requestedAudience.groupGrants, "teamGroupId"),
        )
        || !isDeepStrictEqual(
            sortedAudience(storedCurrentAudience.memberGrants, "teamMembershipId"),
            sortedAudience(requestedAudience.memberGrants, "teamMembershipId"),
        );
    const managerOwnedChanged = (!resource.enabled && replacement.enabled)
        || input.replacement.displayName !== undefined
        || resource.sessionUsePolicy !== replacement.sessionUsePolicy
        || !isDeepStrictEqual(storedRequestPolicy.data, replacement.requestPolicy)
        || audienceChanged
        || replacement.usageLimitDelta.upserts.length > 0
        || replacement.usageLimitDelta.deleteIds.length > 0;
    const requestPolicyChanged = !isDeepStrictEqual(storedRequestPolicy.data, replacement.requestPolicy);

    if (managerOwnedChanged) {
        const managerAuthority = await authority.requireManager();
        if (!managerAuthority.ok) return managerAuthority;
    }
    if (resource.enabled && !replacement.enabled) {
        const withdrawal = await authority.requireWithdrawal();
        if (!withdrawal.ok) return withdrawal;
    }

    const custodianBlock = replacement.custodian;
    if (custodianBlock !== undefined) {
        if (!authority.isCustodian) return { ok: false, error: "resource_forbidden" };
        const withdrawsOnly = isDeepStrictEqual(storedSource.data, custodianBlock.source)
            && isDeepStrictEqual(storedPlacement.placement, custodianBlock.brokerPlacement)
            && withdrawsRouteConsent(storedDelivery.data.policy, custodianBlock.deliveryPolicy);
        const custodianAuthority = withdrawsOnly
            ? await authority.requireWithdrawal()
            : await authority.requireCustodianConsent();
        if (!custodianAuthority.ok) return custodianAuthority;
    }
    const displayName = input.replacement.displayName === undefined
        ? { kind: 'ready' as const, label: storedDisplayName, serialized: resource.displayName }
        : await prepareTeamCredentialResourceDisplayNameForWriteInTx({
            tx,
            ownerAccountId: input.actorAccountId,
            teamId: resource.teamId,
            label: replacement.displayName,
        });
    if (displayName.kind !== 'ready') return { ok: false, error: 'invalid_resource_input' };
    const nextSource = custodianBlock?.source ?? storedSource.data;
    const nextDeliveryPolicy = custodianBlock?.deliveryPolicy ?? storedDelivery.data.policy;
    const deliveryPolicyChanged = !isDeepStrictEqual(storedDelivery.data.policy, nextDeliveryPolicy);
    const nextPlacement = custodianBlock === undefined ? storedPlacement.placement : custodianBlock.brokerPlacement;
    const removesAllowedRoute = storedDelivery.data.policy.preferredAllowedModes.some(route => !nextDeliveryPolicy.preferredAllowedModes.includes(route));
    const nextAudience = removesAllowedRoute
        ? narrowTeamCredentialAudience(replacement, nextDeliveryPolicy.preferredAllowedModes)
        : replacement;
    const storedNextAudience = serializeTeamCredentialAudience(nextAudience);
    const nextAudienceChanged = storedCurrentAudience.allMembersDeliveryMode !== storedNextAudience.allMembersDeliveryMode
        || !isDeepStrictEqual(
            sortedAudience(storedCurrentAudience.groupGrants, "teamGroupId"),
            sortedAudience(storedNextAudience.groupGrants, "teamGroupId"),
        )
        || !isDeepStrictEqual(
            sortedAudience(storedCurrentAudience.memberGrants, "teamMembershipId"),
            sortedAudience(storedNextAudience.memberGrants, "teamMembershipId"),
        );
    const source = await resolveTeamCredentialResourceSourceInTx(tx, {
        custodianAccountId: resource.custodianAccountId,
        source: nextSource,
    });
    if (source.status !== "current") return { ok: false, error: "source_replaced_or_missing" };
    if (nextDeliveryPolicy.preferredAllowedModes.includes('direct') && source.directExportFailure) {
        return { ok: false, error: source.directExportFailure.code, message: source.directExportFailure.message };
    }
    if ((!storedDelivery.data.policy.preferredAllowedModes.includes('direct')
            || (nextSource.kind === 'connected_account' && nextSource.providerPurpose !== undefined))
        && nextDeliveryPolicy.preferredAllowedModes.includes('direct')
        && source.directExportSupport === "unsupported") {
        return { ok: false, error: "disclosure_not_allowed" };
    }
    const nextRequestPolicy = requestPolicyChanged && replacement.requestPolicy !== null
        ? input.requestPolicySupport
            && isTeamCredentialRequestPolicySupportEvidenceCurrent({
                evidence: input.requestPolicySupport,
                source: nextSource,
                sourceCurrentness: source.requestPolicyCurrentness,
            })
            ? normalizeTeamCredentialRequestPolicyForPersistence({
                policy: replacement.requestPolicy,
                models: input.requestPolicySupport.models,
            })
            : null
        : replacement.requestPolicy;
    if (replacement.requestPolicy !== null && nextRequestPolicy === null) {
        return { ok: false, error: "update_required" };
    }
    const requestedRoutes = [
        ...(nextAudience.allMembersAllowedRoutes === null ? [] : [nextAudience.allMembersAllowedRoutes]),
        ...nextAudience.groupGrants.map((grant) => grant.allowedRoutes),
        ...nextAudience.memberGrants.map((grant) => grant.allowedRoutes),
    ];
    if (source.directExportSupport === "unsupported"
        && requestedRoutes.some((routes) => routes.includes('direct'))) {
        return { ok: false, error: "disclosure_not_allowed" };
    }
    const audience = await validateTeamCredentialAudienceDraftInTx(tx, {
        teamId: resource.teamId,
        deliveryPolicy: nextDeliveryPolicy,
        brokerPlacement: nextPlacement,
        audience: nextAudience,
    });
    if (!audience.ok) return audience;
    // Retained direct-only placement does not block withdrawal or repair, but
    // selecting another location is always validated, even without brokered grants.
    if (!isDeepStrictEqual(nextPlacement, storedPlacement.placement)
        || requestedRoutes.some(routes => routes.includes('brokered'))) {
        const placement = await validateTeamCredentialBrokerPlacementForSaveInTx(tx, {
            custodianAccountId: resource.custodianAccountId,
            placement: nextPlacement,
        });
        if (!placement.ok) return placement;
    }
    const deleteIds = new Set(replacement.usageLimitDelta.deleteIds);
    const existingLimitsById = new Map(currentLimits.map((limit) => [limit.id, limit]));
    if ([...deleteIds].some((id) => !existingLimitsById.has(id))) return { ok: false, error: "invalid_limit" };
    const limitIdentity = (limit: Readonly<{ subjectKind: string; subjectId: string; period: string; metric: string }>) => (
        JSON.stringify([limit.subjectKind, limit.subjectId, limit.period, limit.metric])
    );
    const existingLimitsByIdentity = new Map(currentLimits.map((limit) => [limitIdentity(limit), limit]));
    const seenUpsertIds = new Set<string>();
    const seenUpsertIdentities = new Set<string>();
    const validatedUpserts: Array<Readonly<{
        existingId: string | null;
        subjectKind: string;
        subjectId: string;
        period: string;
        metric: string;
        maximum: string;
        enabled: boolean;
    }>> = [];
    const usageCapabilities = resolveCurrentTeamCredentialUsageCapabilitiesForResource({
        ...storedNextAudience,
        sessionUsePolicy: replacement.sessionUsePolicy,
    });
    for (const limit of replacement.usageLimitDelta.upserts) {
        const identity = limitIdentity(limit);
        if (seenUpsertIdentities.has(identity) || (limit.id !== undefined && seenUpsertIds.has(limit.id))) {
            return { ok: false, error: "invalid_limit" };
        }
        seenUpsertIdentities.add(identity);
        if (limit.id !== undefined) seenUpsertIds.add(limit.id);
        const byId = limit.id === undefined ? null : existingLimitsById.get(limit.id) ?? null;
        const byIdentity = existingLimitsByIdentity.get(identity) ?? null;
        if (limit.id !== undefined && byId === null) return { ok: false, error: "invalid_limit" };
        if (byId !== null && limitIdentity(byId) !== identity) return { ok: false, error: "invalid_limit" };
        if (byId !== null && byIdentity !== null && byIdentity.id !== byId.id) return { ok: false, error: "invalid_limit" };
        const existing = byId ?? byIdentity;
        if (existing !== null && deleteIds.has(existing.id)) return { ok: false, error: "invalid_limit" };
        const validated = await validateTeamCredentialUsageLimitDraftInTx(tx, {
            teamId: resource.teamId,
            limit,
            usageCapabilities,
        });
        if (!validated.ok) {
            if (validated.error === "subject_not_in_team") {
                return { ok: false, error: "subject_not_in_team" };
            }
            if (validated.error === "token_limit_unavailable") {
                return { ok: false, error: "token_limit_unavailable" };
            }
            if (validated.error === "cost_limit_unavailable") {
                return { ok: false, error: "cost_limit_unavailable" };
            }
            return { ok: false, error: "invalid_limit" };
        }
        validatedUpserts.push({
            existingId: existing?.id ?? null,
            subjectKind: limit.subjectKind,
            subjectId: limit.subjectId,
            period: limit.period,
            metric: limit.metric,
            maximum: validated.maximum,
            enabled: limit.enabled,
        });
    }
    const replacedLimitIds = new Set(validatedUpserts.flatMap((limit) => limit.existingId === null ? [] : [limit.existingId]));
    const retainedLimitRefusal = findTeamCredentialUsageLimitCapabilityRefusal(
        currentLimits.filter((limit) => !deleteIds.has(limit.id) && !replacedLimitIds.has(limit.id)),
        usageCapabilities,
    );
    if (retainedLimitRefusal) return { ok: false, error: retainedLimitRefusal };

    const sourceChanged = !isDeepStrictEqual(storedSource.data, nextSource);
    const directAuthorityChanged = sourceChanged
        || storedDelivery.data.policy.preferredAllowedModes.includes('direct') !== nextDeliveryPolicy.preferredAllowedModes.includes('direct')
        || (resource.enabled && !replacement.enabled);
    // `revision` is the authority revision: selection mutations and fresh
    // broker opens use it as their CAS precondition, and every request presents
    // the revision it evaluated against the current resource. Accepted Session
    // bindings and established operations are not locked to it. It advances
    // only when an authority fact changes; a display-name or usage-limit edit
    // keeps it (the CAS precondition still applies). Limits are enforced by
    // usage admission, so an edit must not retire admitted broker jobs.
    const authorityChanged = sourceChanged
        || deliveryPolicyChanged
        || !isDeepStrictEqual(storedPlacement.placement, nextPlacement)
        || resource.enabled !== replacement.enabled
        || resource.sessionUsePolicy !== replacement.sessionUsePolicy
        || requestPolicyChanged
        || nextAudienceChanged;
    const nextRevision = authorityChanged ? input.expectedRevision + 1 : input.expectedRevision;
    const updated = await tx.teamCredentialResource.updateMany({
        where: { id: resource.id, revision: input.expectedRevision },
        data: {
            enabled: replacement.enabled,
            displayName: displayName.serialized,
            sourceBindingJson: JSON.stringify(nextSource),
            disclosureCeiling: JSON.stringify({ ...storedDelivery.data, policy: nextDeliveryPolicy }),
            sessionUsePolicy: replacement.sessionUsePolicy,
            requestPolicyJson: !requestPolicyChanged ? resource.requestPolicyJson
                : nextRequestPolicy === null ? null : JSON.stringify(nextRequestPolicy),
            brokerMachineId: nextPlacement?.kind === "machine" ? nextPlacement.machineId : null,
            brokerPoolId: nextPlacement?.kind === "machine_pool" ? nextPlacement.poolId : null,
            allMembersDeliveryMode: storedNextAudience.allMembersDeliveryMode,
            ...(directAuthorityChanged ? { directSourceVersionsJson: null } : {}),
            revision: nextRevision,
        },
    });
    if (updated.count !== 1) return { ok: false, error: "resource_changed" };
    if (nextAudienceChanged) {
        await Promise.all([
            tx.teamCredentialGroupGrant.deleteMany({ where: { resourceId: resource.id } }),
            tx.teamCredentialMemberGrant.deleteMany({ where: { resourceId: resource.id } }),
        ]);
        if (storedNextAudience.groupGrants.length > 0) {
            await tx.teamCredentialGroupGrant.createMany({
                data: storedNextAudience.groupGrants.map((grant) => ({ resourceId: resource.id, ...grant })),
            });
        }
        if (storedNextAudience.memberGrants.length > 0) {
            await tx.teamCredentialMemberGrant.createMany({
                data: storedNextAudience.memberGrants.map((grant) => ({ resourceId: resource.id, ...grant })),
            });
        }
    }
    if (deleteIds.size > 0) {
        await tx.teamCredentialUsageLimit.deleteMany({
            where: { resourceId: resource.id, id: { in: [...deleteIds] } },
        });
        for (const limitId of deleteIds) {
            await deleteTeamCredentialUsageCountersInTx(tx, resource.custodianAccountId, limitId);
        }
    }
    for (const limit of validatedUpserts) {
        if (limit.existingId !== null) {
            await tx.teamCredentialUsageLimit.update({
                where: { id: limit.existingId },
                data: { maximum: limit.maximum, enabled: limit.enabled },
            });
        } else {
            await tx.teamCredentialUsageLimit.create({ data: {
                resourceId: resource.id,
                subjectKind: limit.subjectKind,
                subjectId: limit.subjectId,
                period: limit.period,
                metric: limit.metric,
                maximum: limit.maximum,
                enabled: limit.enabled,
            } });
        }
    }
    if (directAuthorityChanged) {
        await tx.teamCredentialRecipientMaterial.deleteMany({ where: { resourceId: resource.id } });
    } else if (nextAudienceChanged) {
        await retainEntitledTeamCredentialRecipientMaterialInTx(tx, { resourceId: resource.id });
    }
    // Vendor-native rules keep serving until their controller re-reads the
    // authority, so an authority change wakes it like resource deletion does.
    if (authorityChanged) await publishNativeCredentialPolicyChangesInTx(tx, { resourceIds: [resource.id] });
    await recordTeamCredentialResourceActivityInTx(tx, {
        teamId: resource.teamId,
        resourceId: resource.id,
        kind: "resource_updated",
        actor: { kind: "account", accountId: input.actorAccountId },
        subjectDisplayName: displayName.label,
    });
    await publishTeamChangedInTx(tx, {
        teamId: resource.teamId,
        additionalAccountIds: [resource.custodianAccountId, input.actorAccountId],
    });
    return { ok: true, resourceId: resource.id, revision: nextRevision };
}

export async function updateTeamCredentialResourceInTx(
    tx: Tx,
    input: Readonly<{
        actorAccountId: string;
        patch: UpdateTeamCredentialResourceInput;
        authentication: TeamOperationAuthenticationContext;
        requestPolicySupport?: TeamCredentialRequestPolicySupportEvidence;
    }>,
): Promise<UpdateTeamCredentialResourceResult> {
    const parsedPatch = TeamCredentialResourceUpdateInputV1Schema.safeParse(input.patch);
    if (!parsedPatch.success) return { ok: false, error: "invalid_resource_input" };
    const patch = parsedPatch.data;
    if (!Number.isSafeInteger(patch.expectedRevision) || patch.expectedRevision < 0
        || (patch.deliveryPolicy !== undefined && !TeamCredentialDeliveryPolicyV1Schema.safeParse(patch.deliveryPolicy).success)
        || (patch.sessionUsePolicy !== undefined && !TeamCredentialSessionUsePolicyV1Schema.safeParse(patch.sessionUsePolicy).success)
        || (patch.requestPolicy !== undefined && !z.nullable(TeamCredentialRequestPolicyV1Schema).safeParse(patch.requestPolicy).success)) {
        return { ok: false, error: "invalid_resource_input" };
    }
    const resourceIdentity = await tx.teamCredentialResource.findUnique({ where: { id: patch.resourceId }, select: { custodianAccountId: true, teamId: true } });
    if (!resourceIdentity) return { ok: false, error: "resource_not_found" };
    const materializedRecipients = await tx.teamCredentialRecipientMaterial.findMany({
        where: { resourceId: patch.resourceId }, select: { recipientAccountId: true }, distinct: ["recipientAccountId"],
    });
    const recheckAdmission = await acquireTeamMembershipAccountAdmissionInTx(tx, {
        teamId: resourceIdentity.teamId,
        accountIds: [input.actorAccountId, resourceIdentity.custodianAccountId, ...materializedRecipients.map(row => row.recipientAccountId),
            ...await readNativeCredentialPolicyPublicationAccountIdsInTx(tx, { resourceIds: [patch.resourceId] })],
        membershipIds: patch.replacement?.memberGrants?.map(grant => grant.teamMembershipId) ?? [],
    });
    await acquireTeamMutationLockInTx(tx, resourceIdentity.teamId);
    await recheckAdmission();
    const resource = await tx.teamCredentialResource.findUnique({ where: { id: patch.resourceId } });
    if (!resource) return { ok: false, error: "resource_not_found" };
    if (resource.custodianAccountId !== resourceIdentity.custodianAccountId) {
        throw new TransactionReplayRequiredError("transaction-account-audience-changed");
    }
    if (patch.replacement !== undefined) {
        return applyResourceReplacementInTx(tx, {
            actorAccountId: input.actorAccountId,
            authentication: input.authentication,
            resource,
            expectedRevision: patch.expectedRevision,
            replacement: patch.replacement,
            requestPolicySupport: input.requestPolicySupport,
        });
    }
    const authority = await resolveTeamCredentialUpdateAuthorityInTx(tx, {
        resource,
        actorAccountId: input.actorAccountId,
        authentication: input.authentication,
    });
    if (!authority.ok) return authority;
    // A broker Machine is part of the private source binding, and delivery
    // allowance and preference are the custodian's consent. Team managers may
    // administer policy and audience within that allowance, but they neither
    // receive nor set another Account's Machine identity or route consent.
    if ((patch.brokerPlacement !== undefined || patch.deliveryPolicy !== undefined) && !authority.isCustodian) {
        return { ok: false, error: "resource_forbidden" };
    }
    if (patch.displayName !== undefined
        || patch.requestPolicy !== undefined
        || patch.sessionUsePolicy !== undefined
        || patch.enabled === true) {
        const managerAuthority = await authority.requireManager();
        if (!managerAuthority.ok) return managerAuthority;
    }
    if (patch.enabled === false) {
        const withdrawal = await authority.requireWithdrawal();
        if (!withdrawal.ok) return withdrawal;
    }
    const requestedPlacement = patch.brokerPlacement;
    if (requestedPlacement !== undefined && (
        (requestedPlacement?.kind === "machine" ? requestedPlacement.machineId : null) !== resource.brokerMachineId
        || (requestedPlacement?.kind === "machine_pool" ? requestedPlacement.poolId : null) !== resource.brokerPoolId)) {
        const consent = await authority.requireCustodianConsent();
        if (!consent.ok) return consent;
    }
    if (resource.revision !== patch.expectedRevision) return { ok: false, error: "resource_changed" };
    const storedDisplayName = readTeamCredentialResourceDisplayNameStored(resource.displayName);
    if (storedDisplayName === null) return { ok: false, error: 'resource_corrupt' };
    const storedDelivery = readTeamCredentialDeliveryConfiguration(resource.disclosureCeiling);
    const sessionPolicy = TeamCredentialSessionUsePolicyV1Schema.safeParse(patch.sessionUsePolicy ?? resource.sessionUsePolicy);
    const storedRequestPolicy = (() => {
        if (resource.requestPolicyJson === null) return null;
        try { return JSON.parse(resource.requestPolicyJson) as unknown; } catch { return undefined; }
    })();
    const requestPolicy = z.nullable(TeamCredentialRequestPolicyV1Schema).safeParse(
        patch.requestPolicy === undefined ? storedRequestPolicy : patch.requestPolicy,
    );
    if (!storedDelivery.success || !sessionPolicy.success || !requestPolicy.success) return { ok: false, error: "resource_corrupt" };
    const nextDeliveryPolicy = patch.deliveryPolicy ?? storedDelivery.data.policy;
    const deliveryPolicyChanged = !isDeepStrictEqual(storedDelivery.data.policy, nextDeliveryPolicy);
    if (!withdrawsRouteConsent(storedDelivery.data.policy, nextDeliveryPolicy)) {
        const consent = await authority.requireCustodianConsent();
        if (!consent.ok) return consent;
    }
    const [currentGroups, currentMembers] = await Promise.all([
        tx.teamCredentialGroupGrant.findMany({ where: { resourceId: resource.id }, select: { teamGroupId: true, deliveryMode: true } }),
        tx.teamCredentialMemberGrant.findMany({ where: { resourceId: resource.id }, select: { teamMembershipId: true, deliveryMode: true } }),
    ]);
    const currentAudience = readTeamCredentialAudience({ allMembersDeliveryMode: resource.allMembersDeliveryMode,
        groupGrants: currentGroups, memberGrants: currentMembers });
    if (!currentAudience.success) return { ok: false, error: 'resource_corrupt' };
    if (sessionPolicy.data !== resource.sessionUsePolicy) {
        const limits = await tx.teamCredentialUsageLimit.findMany({ where: { resourceId: resource.id }, select: { metric: true, enabled: true } });
        const limitRefusal = findTeamCredentialUsageLimitCapabilityRefusal(limits, resolveCurrentTeamCredentialUsageCapabilitiesForResource({
            allMembersDeliveryMode: resource.allMembersDeliveryMode,
            groupGrants: currentGroups,
            memberGrants: currentMembers,
            sessionUsePolicy: sessionPolicy.data,
        }));
        if (limitRefusal) return { ok: false, error: limitRefusal };
    }
    const requestPolicyChanged = !isDeepStrictEqual(storedRequestPolicy, requestPolicy.data);
    let nextRequestPolicy = requestPolicy.data;
    if (requestPolicyChanged && requestPolicy.data !== null) {
        const storedSource = readTeamCredentialSourceBinding(resource.sourceBindingJson);
        if (!storedSource.success) return { ok: false, error: "resource_corrupt" };
        const currentSource = await resolveTeamCredentialResourceSourceInTx(tx, {
            custodianAccountId: resource.custodianAccountId,
            source: storedSource.data,
        });
        if (currentSource.status !== "current") return { ok: false, error: "source_replaced_or_missing" };
        nextRequestPolicy = input.requestPolicySupport
            && isTeamCredentialRequestPolicySupportEvidenceCurrent({
                evidence: input.requestPolicySupport,
                source: storedSource.data,
                sourceCurrentness: currentSource.requestPolicyCurrentness,
            })
            ? normalizeTeamCredentialRequestPolicyForPersistence({
                policy: requestPolicy.data,
                models: input.requestPolicySupport.models,
            })
            : null;
        if (nextRequestPolicy === null) return { ok: false, error: "update_required" };
    }
    const isWideningDisclosure = nextDeliveryPolicy.preferredAllowedModes.some(route => !storedDelivery.data.policy.preferredAllowedModes.includes(route));
    if (isWideningDisclosure) {
        // Widening was consented above; the source must still be current and
        // able to export direct material.
        const storedSource = readTeamCredentialSourceBinding(resource.sourceBindingJson);
        if (!storedSource.success) return { ok: false, error: "resource_corrupt" };
        const currentSource = await resolveTeamCredentialResourceSourceInTx(tx, {
            custodianAccountId: resource.custodianAccountId,
            source: storedSource.data,
        });
        if (currentSource.status !== "current") return { ok: false, error: "source_replaced_or_missing" };
        if (nextDeliveryPolicy.preferredAllowedModes.includes('direct') && currentSource.directExportFailure) {
            return { ok: false, error: currentSource.directExportFailure.code, message: currentSource.directExportFailure.message };
        }
        if (!storedDelivery.data.policy.preferredAllowedModes.includes('direct')
            && nextDeliveryPolicy.preferredAllowedModes.includes('direct')
            && currentSource.directExportSupport === "unsupported") return { ok: false, error: "disclosure_not_allowed" };
    }
    const isLoweringDisclosure = storedDelivery.data.policy.preferredAllowedModes.some(route => !nextDeliveryPolicy.preferredAllowedModes.includes(route));
    const nextAudience = isLoweringDisclosure
        ? narrowTeamCredentialAudience(currentAudience.data, nextDeliveryPolicy.preferredAllowedModes)
        : currentAudience.data;
    const storedNextAudience = serializeTeamCredentialAudience(nextAudience);
    const storedPlacement = readTeamCredentialBrokerPlacement(resource);
    if (!storedPlacement.ok) return { ok: false, error: "resource_corrupt" };
    const parsedPlacement = z.nullable(TeamCredentialBrokerPlacementV1Schema).safeParse(
        patch.brokerPlacement === undefined ? storedPlacement.placement : patch.brokerPlacement,
    );
    if (!parsedPlacement.success) return { ok: false, error: "resource_corrupt" };
    const brokerMachineId = parsedPlacement.data?.kind === "machine" ? parsedPlacement.data.machineId : null;
    const brokerPoolId = parsedPlacement.data?.kind === "machine_pool" ? parsedPlacement.data.poolId : null;
    const existingBrokerAudience = nextAudience.allMembersAllowedRoutes?.includes('brokered') === true
        || nextAudience.groupGrants.some(grant => grant.allowedRoutes.includes('brokered'))
        || nextAudience.memberGrants.some(grant => grant.allowedRoutes.includes('brokered'));
    // Save readiness answers "may this placement be selected", so it is asked of
    // a placement this patch actually selects. A patch that only takes authority
    // away — disabling the resource, or narrowing its ceiling — keeps whatever
    // placement is already stored, and must not be blocked by that placement's
    // Machine having been revoked, replaced or removed: withdrawal is exactly
    // the custodian's recovery when the broker is gone, and `resourceDelete`
    // already works. Every other patch, and any newly selected placement, is
    // validated normally.
    const keepsStoredPlacement = brokerMachineId === resource.brokerMachineId
        && brokerPoolId === resource.brokerPoolId;
    const reducesAuthorityOnly = keepsStoredPlacement
        && !isWideningDisclosure
        && !(patch.enabled === true && !resource.enabled)
        && sessionPolicy.data === resource.sessionUsePolicy
        && !requestPolicyChanged
        && (patch.enabled === false || isLoweringDisclosure);
    if (!reducesAuthorityOnly) {
        if (existingBrokerAudience && brokerMachineId === null && brokerPoolId === null) return { ok: false, error: "broker_unavailable" };
        if (!keepsStoredPlacement || existingBrokerAudience) {
            const placement = await validateTeamCredentialBrokerPlacementForSaveInTx(tx, {
                custodianAccountId: resource.custodianAccountId,
                placement: parsedPlacement.data,
            });
            if (!placement.ok) return placement;
        }
    }
    const displayName = patch.displayName === undefined
        ? { kind: 'ready' as const, label: storedDisplayName, serialized: resource.displayName }
        : await prepareTeamCredentialResourceDisplayNameForWriteInTx({
            tx,
            ownerAccountId: input.actorAccountId,
            teamId: resource.teamId,
            label: patch.displayName,
        });
    if (displayName.kind !== 'ready') return { ok: false, error: 'invalid_resource_input' };
    // See applyResourceReplacementInTx: only authority facts advance `revision`.
    const authorityChanged = (patch.enabled !== undefined && patch.enabled !== resource.enabled)
        || deliveryPolicyChanged
        || sessionPolicy.data !== resource.sessionUsePolicy
        || requestPolicyChanged
        || brokerMachineId !== resource.brokerMachineId
        || brokerPoolId !== resource.brokerPoolId;
    const nextRevision = authorityChanged ? patch.expectedRevision + 1 : patch.expectedRevision;
    const updated = await tx.teamCredentialResource.updateMany({ where: { id: resource.id, revision: patch.expectedRevision }, data: {
        ...(patch.displayName === undefined ? {} : { displayName: displayName.serialized }),
        ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
        disclosureCeiling: JSON.stringify({ ...storedDelivery.data, policy: nextDeliveryPolicy }), sessionUsePolicy: sessionPolicy.data,
        requestPolicyJson: nextRequestPolicy === null ? null : JSON.stringify(nextRequestPolicy),
        brokerMachineId, brokerPoolId, revision: nextRevision,
        allMembersDeliveryMode: storedNextAudience.allMembersDeliveryMode,
    } });
    if (updated.count !== 1) return { ok: false, error: "resource_changed" };
    if (isLoweringDisclosure) {
        await Promise.all([
            tx.teamCredentialGroupGrant.deleteMany({ where: { resourceId: resource.id } }),
            tx.teamCredentialMemberGrant.deleteMany({ where: { resourceId: resource.id } }),
        ]);
        if (storedNextAudience.groupGrants.length) await tx.teamCredentialGroupGrant.createMany({
            data: storedNextAudience.groupGrants.map(grant => ({ resourceId: resource.id, ...grant })),
        });
        if (storedNextAudience.memberGrants.length) await tx.teamCredentialMemberGrant.createMany({
            data: storedNextAudience.memberGrants.map(grant => ({ resourceId: resource.id, ...grant })),
        });
    }
    if (patch.enabled === false || (isLoweringDisclosure && !nextDeliveryPolicy.preferredAllowedModes.includes('direct'))) {
        await tx.teamCredentialRecipientMaterial.deleteMany({ where: { resourceId: resource.id } });
        await tx.teamCredentialResource.update({
            where: { id: resource.id },
            data: { directSourceVersionsJson: null },
        });
    }
    if (authorityChanged) await publishNativeCredentialPolicyChangesInTx(tx, { resourceIds: [resource.id] });
    await recordTeamCredentialResourceActivityInTx(tx, {
        teamId: resource.teamId, resourceId: resource.id, kind: "resource_updated",
        actor: { kind: "account", accountId: input.actorAccountId }, subjectDisplayName: displayName.label,
    });
    await publishTeamChangedInTx(tx, { teamId: resource.teamId, additionalAccountIds: [resource.custodianAccountId, input.actorAccountId] });
    return { ok: true, resourceId: resource.id, revision: nextRevision };
}
