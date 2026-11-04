import { TeamCredentialAllowedRoutesV1Schema, type TeamCredentialBrokerPlacementV1, type TeamCredentialDeliveryPolicyV1, type TeamCredentialAllowedRoutesV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { readTeamCredentialAudience, readTeamCredentialDeliveryConfiguration, serializeTeamCredentialAudience } from './resourceDeliveryRead';
import { readTeamCredentialSourceBinding } from './sourceBindingRead';
import { TransactionReplayRequiredError, type Tx } from "@/storage/inTx";
import { acquireTeamMembershipAccountAdmissionInTx } from "../memberships/membershipService";
import { AccountStatus } from "@/storage/enums.generated";
import { acquireTeamMutationLockInTx, resolveTeamActorContextInTx, type TeamOperationAuthenticationContext } from "../actorContext";
import { resolveTeamCredentialCapabilities } from "../capabilities";
import { resolveTeamMembershipContextInTx } from "../memberships/effectiveMembership";
import { publishTeamChangedInTx } from "../teamChanges";
import { recordTeamCredentialActivityInTx, type TeamCredentialActivityActor } from "./resourceActivity";
import { readTeamCredentialBrokerPlacement, validateTeamCredentialBrokerPlacementForSaveInTx } from "./brokerPlacementResolver";
import { qualifyTeamCredentialOperationInTx } from "./resourceRead";
import { retainEntitledTeamCredentialRecipientMaterialInTx } from "./recipientMaterial";
import { resolveTeamCredentialResourceSourceInTx } from "./resourceSourceResolver";

export type TeamCredentialAudienceInput = Readonly<{
    resourceId: string;
    expectedRevision: number;
    allMembersAllowedRoutes: TeamCredentialAllowedRoutesV1 | null;
    groupGrants: readonly Readonly<{ teamGroupId: string; allowedRoutes: TeamCredentialAllowedRoutesV1 }>[];
    memberGrants: readonly Readonly<{ teamMembershipId: string; allowedRoutes: TeamCredentialAllowedRoutesV1 }>[];
}>;

export type TeamCredentialAudienceResult =
    | Readonly<{ ok: true; resourceId: string; revision: number }>
    | Readonly<{ ok: false; error: "resource_not_found" | "resource_forbidden" | "resource_changed" | "invalid_audience" | "disclosure_not_allowed" | "broker_unavailable" | "update_required" | "resource_corrupt" | "team_authentication_required" | "team_authentication_policy_unavailable" }>;

export async function validateTeamCredentialAudienceDraftInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        deliveryPolicy: TeamCredentialDeliveryPolicyV1;
        brokerPlacement: TeamCredentialBrokerPlacementV1 | null;
        audience: Omit<TeamCredentialAudienceInput, 'resourceId' | 'expectedRevision'>;
    }>,
): Promise<Readonly<{ ok: true }> | Readonly<{ ok: false; error: 'invalid_audience' | 'disclosure_not_allowed' | 'broker_unavailable' }>> {
    const { audience } = input;
    const modes = [
        ...(audience.allMembersAllowedRoutes === null ? [] : [audience.allMembersAllowedRoutes]),
        ...audience.groupGrants.map(grant => grant.allowedRoutes),
        ...audience.memberGrants.map(grant => grant.allowedRoutes),
    ];
    if (modes.some(mode => !TeamCredentialAllowedRoutesV1Schema.safeParse(mode).success)
        || new Set(audience.groupGrants.map(grant => grant.teamGroupId)).size !== audience.groupGrants.length
        || new Set(audience.memberGrants.map(grant => grant.teamMembershipId)).size !== audience.memberGrants.length) {
        return { ok: false, error: 'invalid_audience' };
    }
    if (modes.some(routes => routes.some(route => !input.deliveryPolicy.preferredAllowedModes.includes(route)))) {
        return { ok: false, error: 'disclosure_not_allowed' };
    }
    if (modes.some(routes => routes.includes('brokered')) && input.brokerPlacement === null) {
        return { ok: false, error: 'broker_unavailable' };
    }
    const groups = await tx.teamGroup.findMany({
        where: { id: { in: audience.groupGrants.map(grant => grant.teamGroupId) }, teamId: input.teamId, archivedAt: null },
        select: { id: true },
    });
    if (groups.length !== audience.groupGrants.length) return { ok: false, error: 'invalid_audience' };
    for (const grant of audience.memberGrants) {
        const membership = await tx.teamMembership.findUnique({ where: { id: grant.teamMembershipId }, select: { accountId: true } });
        if (!membership) return { ok: false, error: 'invalid_audience' };
        const current = await resolveTeamMembershipContextInTx(tx, {
            teamId: input.teamId,
            teamMembershipId: grant.teamMembershipId,
            expectedAccountId: membership.accountId,
        });
        if (!current.ok || !current.membership.effective) return { ok: false, error: 'invalid_audience' };
    }
    return { ok: true };
}

/**
 * Ends membership-lifetime credential authority before the membership row is
 * removed. This is deliberately owned beside the ordinary audience writer:
 * membership deletion must not rely on foreign-key cascade as its only
 * authorization mutation, and recipient material must disappear in the same
 * transaction as the lifetime that made it readable.
 */
export async function revokeTeamCredentialAudienceForMembershipInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        teamMembershipId: string;
        accountId: string;
        actor: TeamCredentialActivityActor;
    }>,
): Promise<void> {
    const [grantedResources, materializedResources] = await Promise.all([
        tx.teamCredentialResource.findMany({
            where: {
                teamId: input.teamId,
                memberGrants: { some: { teamMembershipId: input.teamMembershipId } },
            },
            select: { id: true, displayName: true },
        }),
        tx.teamCredentialResource.findMany({
            where: {
                teamId: input.teamId,
                directRecipientMaterials: { some: { recipientAccountId: input.accountId } },
            },
            select: { id: true, displayName: true },
        }),
    ]);
    const affectedResources = new Map(
        [...grantedResources, ...materializedResources].map(resource => [resource.id, resource]),
    );
    if (affectedResources.size === 0) return;

    await tx.teamCredentialMemberGrant.deleteMany({
        where: {
            teamMembershipId: input.teamMembershipId,
            resource: { teamId: input.teamId },
        },
    });
    await tx.teamCredentialRecipientMaterial.deleteMany({
        where: {
            recipientAccountId: input.accountId,
            resource: { teamId: input.teamId },
        },
    });
    if (grantedResources.length > 0) {
        await tx.teamCredentialResource.updateMany({
            where: { id: { in: grantedResources.map(resource => resource.id) } },
            data: { revision: { increment: 1 } },
        });
    }
    for (const resource of affectedResources.values()) {
        await recordTeamCredentialActivityInTx(tx, {
            teamId: input.teamId,
            resourceId: resource.id,
            kind: "audience_changed",
            actor: input.actor,
            subjectDisplayName: resource.displayName,
        });
    }
}

function isDeliveryNarrowing(
    current: TeamCredentialAllowedRoutesV1 | null,
    next: TeamCredentialAllowedRoutesV1 | null,
): boolean {
    return (next ?? []).every(route => current?.includes(route));
}

function grantsBySubject<T extends string>(
    grants: readonly Readonly<{ allowedRoutes: TeamCredentialAllowedRoutesV1 } & Record<T, string>>[],
    subject: T,
): ReadonlyMap<string, TeamCredentialAllowedRoutesV1> {
    return new Map(grants.map(grant => [grant[subject], grant.allowedRoutes]));
}

/** Replace the complete audience at the resource's one revision boundary. */
export async function setTeamCredentialAudienceInTx(
    tx: Tx,
    params: Readonly<{ actorAccountId: string; input: TeamCredentialAudienceInput; authentication: TeamOperationAuthenticationContext }>,
): Promise<TeamCredentialAudienceResult> {
    const { input } = params;
    const resourceIdentity = await tx.teamCredentialResource.findUnique({ where: { id: input.resourceId }, select: { custodianAccountId: true, teamId: true } });
    if (!resourceIdentity) return { ok: false, error: "resource_not_found" };
    const materializedRecipients = await tx.teamCredentialRecipientMaterial.findMany({
        where: { resourceId: input.resourceId }, select: { recipientAccountId: true }, distinct: ["recipientAccountId"],
    });
    const recheckAdmission = await acquireTeamMembershipAccountAdmissionInTx(tx, {
        teamId: resourceIdentity.teamId,
        accountIds: [params.actorAccountId, resourceIdentity.custodianAccountId, ...materializedRecipients.map(row => row.recipientAccountId)],
        membershipIds: input.memberGrants.map(grant => grant.teamMembershipId),
    });
    await acquireTeamMutationLockInTx(tx, resourceIdentity.teamId);
    await recheckAdmission();
    const resource = await tx.teamCredentialResource.findUnique({ where: { id: input.resourceId } });
    if (!resource) return { ok: false, error: "resource_not_found" };
    if (resource.custodianAccountId !== resourceIdentity.custodianAccountId) {
        throw new TransactionReplayRequiredError("transaction-account-audience-changed");
    }
    const actor = await resolveTeamActorContextInTx(tx, { teamId: resource.teamId, actorAccountId: params.actorAccountId });
    const canManageStructurally = actor !== null
        && resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt }).manageCredentials;
    const isCustodian = resource.custodianAccountId === params.actorAccountId;
    const custodianAccount = isCustodian
        ? await tx.account.findUnique({ where: { id: params.actorAccountId }, select: { status: true } })
        : null;
    const isActiveCustodian = custodianAccount?.status === AccountStatus.active;
    if (!canManageStructurally && !isActiveCustodian) return { ok: false, error: "resource_forbidden" };
    const qualification = canManageStructurally && actor
        ? await qualifyTeamCredentialOperationInTx(tx, actor, params.authentication)
        : { ok: false as const, error: "team_authentication_required" as const };
    if (!isActiveCustodian && !qualification.ok) return qualification;
    const canManage = canManageStructurally && qualification.ok;
    if (resource.revision !== input.expectedRevision) return { ok: false, error: "resource_changed" };
    const ceiling = readTeamCredentialDeliveryConfiguration(resource.disclosureCeiling);
    if (!ceiling.success) return { ok: false, error: "resource_corrupt" };
    const modes = [
        ...(input.allMembersAllowedRoutes === null ? [] : [input.allMembersAllowedRoutes]),
        ...input.groupGrants.map(grant => grant.allowedRoutes),
        ...input.memberGrants.map(grant => grant.allowedRoutes),
    ];
    if (modes.some(routes => routes.includes('direct'))) {
        const source = readTeamCredentialSourceBinding(resource.sourceBindingJson);
        if (!source.success) return { ok: false, error: "resource_corrupt" };
        const currentSource = await resolveTeamCredentialResourceSourceInTx(tx, {
            custodianAccountId: resource.custodianAccountId,
            source: source.data,
        });
        if (currentSource.status !== "current") {
            return { ok: false, error: "resource_changed" };
        }
        if (currentSource.directExportSupport === "unsupported") {
            return { ok: false, error: "disclosure_not_allowed" };
        }
    }
    if (!canManage) {
        const [currentGroupGrants, currentMemberGrants] = await Promise.all([
            tx.teamCredentialGroupGrant.findMany({
                where: { resourceId: resource.id },
                select: { teamGroupId: true, deliveryMode: true },
            }),
            tx.teamCredentialMemberGrant.findMany({
                where: { resourceId: resource.id },
                select: { teamMembershipId: true, deliveryMode: true },
            }),
        ]);
        const current = readTeamCredentialAudience({ allMembersDeliveryMode: resource.allMembersDeliveryMode,
            groupGrants: currentGroupGrants, memberGrants: currentMemberGrants });
        if (!current.success) return { ok: false, error: 'resource_corrupt' };
        const currentGroups = grantsBySubject(current.data.groupGrants, 'teamGroupId');
        const currentMembers = grantsBySubject(current.data.memberGrants, 'teamMembershipId');
        const narrowsAudience = isDeliveryNarrowing(
            current.data.allMembersAllowedRoutes,
            input.allMembersAllowedRoutes,
        ) && input.groupGrants.every(grant => isDeliveryNarrowing(
            currentGroups.get(grant.teamGroupId) ?? null,
            grant.allowedRoutes,
        )) && input.memberGrants.every(grant => isDeliveryNarrowing(
            currentMembers.get(grant.teamMembershipId) ?? null,
            grant.allowedRoutes,
        ));
        if (!narrowsAudience) return { ok: false, error: "resource_forbidden" };
    }
    const storedPlacement = readTeamCredentialBrokerPlacement(resource);
    if (!storedPlacement.ok) return { ok: false, error: "resource_corrupt" };
    const validation = await validateTeamCredentialAudienceDraftInTx(tx, {
        teamId: resource.teamId,
        deliveryPolicy: ceiling.data.policy,
        brokerPlacement: storedPlacement.placement,
        audience: input,
    });
    if (!validation.ok) return validation;
    // An audience-only withdrawal does not select a new location. Retain its
    // repair path; an audience that still grants brokerage validates the saved location.
    if (modes.some(routes => routes.includes('brokered'))) {
        const placement = await validateTeamCredentialBrokerPlacementForSaveInTx(tx, {
            custodianAccountId: resource.custodianAccountId,
            placement: storedPlacement.placement,
        });
        if (!placement.ok) return placement;
    }
    const storedAudience = serializeTeamCredentialAudience({ allMembersAllowedRoutes: input.allMembersAllowedRoutes,
        groupGrants: [...input.groupGrants], memberGrants: [...input.memberGrants] });
    const updated = await tx.teamCredentialResource.updateMany({
        where: { id: resource.id, revision: input.expectedRevision },
        data: { allMembersDeliveryMode: storedAudience.allMembersDeliveryMode,
            disclosureCeiling: JSON.stringify(ceiling.data), revision: { increment: 1 } },
    });
    if (updated.count !== 1) return { ok: false, error: "resource_changed" };
    await tx.teamCredentialGroupGrant.deleteMany({ where: { resourceId: resource.id } });
    await tx.teamCredentialMemberGrant.deleteMany({ where: { resourceId: resource.id } });
    if (input.groupGrants.length > 0) {
        await tx.teamCredentialGroupGrant.createMany({ data: storedAudience.groupGrants.map(grant => ({ resourceId: resource.id, ...grant })) });
    }
    if (input.memberGrants.length > 0) {
        await tx.teamCredentialMemberGrant.createMany({ data: storedAudience.memberGrants.map(grant => ({ resourceId: resource.id, ...grant })) });
    }
    // Recipient material is a projection of who may receive directly, per
    // recipient — not of the audience as a whole. Replacing the audience ends
    // it for exactly the recipients the new audience no longer entitles, and
    // the entitlement owner decides that. The source is unchanged by an
    // audience edit, so the published source versions are unchanged too and a
    // retained recipient keeps working while the custodian is offline.
    await retainEntitledTeamCredentialRecipientMaterialInTx(tx, { resourceId: resource.id });
    await recordTeamCredentialActivityInTx(tx, {
        teamId: resource.teamId, resourceId: resource.id, kind: "audience_changed",
        actor: { kind: "account", accountId: params.actorAccountId }, subjectDisplayName: resource.displayName,
    });
    await publishTeamChangedInTx(tx, { teamId: resource.teamId, additionalAccountIds: [resource.custodianAccountId] });
    return { ok: true, resourceId: resource.id, revision: resource.revision + 1 };
}
