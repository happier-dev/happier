import { computeTeamCredentialSourceMemberKeyV1, matchesTeamCredentialSourceVersionBasisV1 } from '@happier-dev/protocol/teams/credentials/directMaterialV1';
import { TeamCredentialDeliveryModeV1Schema, TeamCredentialDisclosureCeilingV1Schema, TeamCredentialResourceCatalogEntryV1Schema, TeamCredentialResourceAudienceGrantV1Schema, TeamCredentialResourceMemberGrantV1Schema, TeamCredentialResourceSummaryV1Schema, TeamCredentialSessionUsePolicyV1Schema, decodeTeamCredentialResourcesCursorV1, encodeTeamCredentialResourcesCursorV1, teamCredentialResourcesQueryKeyV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { TeamCredentialSourceBindingV1Schema, type TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import { readTeamCredentialSourceBinding } from './sourceBindingRead';
import { TeamCredentialSourceResourceAdministrationV1Schema, teamCredentialSourceLocatorKeyV1, teamCredentialSourceLocatorV1, type TeamCredentialSourceLocatorV1 } from '@happier-dev/protocol/teams';
import type { ProviderBrokerApplicationBindingV1 } from '@happier-dev/protocol/providers/brokerRouteGrantV1';

import type { Tx } from "@/storage/inTx";
import { portableQueryChunks } from "@/storage/portableQueryChunks";
import type { TeamCredentialErrorCodeV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { resolveAccountDisplayLabelV1 } from "@/app/account/profile/accountDisplayProfile";
import {
    qualifyTeamOperationAuthenticationInTx,
    qualifyTeamOperationAuthenticationsInTx,
    resolveTeamActorContextInTx,
    resolveTeamActorContextsInTx,
    type TeamOperationAuthenticationContext,
} from "../actorContext";
import { resolveTeamCredentialCapabilities } from "../capabilities";
import { readTeamCredentialBrokerPlacement } from "./brokerPlacementResolver";
import { deriveAccountEncryptionCurrentnessFromRow } from "@/app/encryption/accountContentKeyAdmission";
import {
    hasCurrentTeamCredentialAudienceMatchInTx,
    projectTeamCredentialEntitlement,
    resolveTeamCredentialEntitlementInTx,
} from "./resourceAccess";
import { isEffectiveTeamMembership, type TeamMembershipLifetimeContext } from "../memberships/effectiveMembership";
import { isEffectiveTeamGroupMembership, type TeamGroupMembershipLifetimeContext } from "../groups/effectiveGroupMembership";
import { sessionHistoryAccessOf } from "../memberships/sessionHistory";
import {
    listTeamCredentialDirectSourceMembersInTx,
    parsePublishedTeamCredentialSourceVersions,
    projectTeamCredentialDirectSourceCurrentnesses,
    resolveTeamCredentialSourceMemberCurrentnessInTx,
    resolveTeamCredentialResourceSourceInTx,
    resolveTeamCredentialResourceSourcesInTx,
    type TeamCredentialResourceSourceResolution,
} from "./resourceSourceResolver";
import { matchesTeamCredentialRecipientBinding } from "./recipientMaterialCurrentness";
import { hasTeamCredentialDirectDeliveryActivityInTx } from "./resourceActivity";
import { resolveCurrentTeamCredentialUsageCapabilitiesForResource } from './usageCapabilities';
import { classifyTeamCredentialBrokerMachineEligibility } from './brokerMachineEligibility';
import { projectTeamCredentialResourceAdministrationCapabilities } from './resourceAdministrationCapabilities';
import {
    evaluateTeamCredentialUsageAdmissionLimitsForResourcesInTx,
    type TeamCredentialUsageAdmissionLimitEvaluation,
} from './teamCredentialUsageLimits';

type ResourceAudience = Readonly<{
    groupGrants: readonly { teamGroupId: string; deliveryMode: string }[];
    memberGrants: readonly { teamMembershipId: string; deliveryMode: string }[];
}>;

const NO_AUDIENCE: ResourceAudience = { groupGrants: [], memberGrants: [] };

/**
 * The candidate window the external-API listing walks, in rows.
 *
 * This is the maximum `limit` the administration-list contract already accepts
 * (`TeamCredentialResourceListInputV1Schema.limit`, `packages/protocol/src/teams/credentials/resourceV1.ts`),
 * reused so a candidate window is never smaller than a page this endpoint may
 * be asked to serve. It bounds nothing new: a single request may already ask
 * for this many resources, and the walk still stops on the Team's own keyset.
 */
const EXTERNAL_API_CANDIDATE_WINDOW = 100;

async function readAudiencesInTx(tx: Tx, resourceIds: readonly string[]): Promise<Map<string, ResourceAudience>> {
    const audiences = new Map<string, { groupGrants: { teamGroupId: string; deliveryMode: string }[]; memberGrants: { teamMembershipId: string; deliveryMode: string }[] }>();
    if (resourceIds.length === 0) return audiences;
    for (const id of resourceIds) audiences.set(id, { groupGrants: [], memberGrants: [] });
    const [groups, members] = await Promise.all([
        tx.teamCredentialGroupGrant.findMany({
            where: { resourceId: { in: [...resourceIds] } },
            select: { resourceId: true, teamGroupId: true, deliveryMode: true },
            orderBy: { teamGroupId: "asc" },
        }),
        tx.teamCredentialMemberGrant.findMany({
            where: { resourceId: { in: [...resourceIds] } },
            select: { resourceId: true, teamMembershipId: true, deliveryMode: true },
            orderBy: { teamMembershipId: "asc" },
        }),
    ]);
    for (const grant of groups) audiences.get(grant.resourceId)?.groupGrants.push({
        teamGroupId: grant.teamGroupId,
        deliveryMode: grant.deliveryMode,
    });
    for (const grant of members) audiences.get(grant.resourceId)?.memberGrants.push({
        teamMembershipId: grant.teamMembershipId,
        deliveryMode: grant.deliveryMode,
    });
    return audiences;
}

type ResourceRow = Readonly<{
    id: string;
    teamId: string;
    custodianAccountId: string;
    displayName: string;
    enabled: boolean;
    revision: number;
    disclosureCeiling: string;
    sessionUsePolicy: string;
    sourceBindingJson: string;
    directSourceVersionsJson: string | null;
    requestPolicyJson: string | null;
    brokerMachineId: string | null;
    brokerPoolId: string | null;
    allMembersDeliveryMode: string | null;
    createdAt: Date;
    updatedAt: Date;
}>;

type ExternalKeyMembershipRow = Readonly<{
    id: string;
    teamId: string;
    accountId: string;
    role: TeamMembershipLifetimeContext["role"];
    status: TeamMembershipLifetimeContext["status"];
    sessionAccessStartsAt: Date | null;
    account: Readonly<{ status: Parameters<typeof isEffectiveTeamMembership>[0]["accountStatus"] }>;
    team: Readonly<{ archivedAt: Date | null }>;
    groupMemberships: readonly Readonly<{
        teamGroupId: string;
        nativeContribution: boolean;
        sessionAccessStartsAt: Date | null;
        group: Readonly<{ teamId: string; archivedAt: Date | null }>;
    }>[];
}>;

function projectExternalKeyMembership(row: ExternalKeyMembershipRow): TeamMembershipLifetimeContext {
    return {
        teamMembershipId: row.id,
        teamId: row.teamId,
        accountId: row.accountId,
        role: row.role,
        status: row.status,
        sessionAccessStartsAt: row.sessionAccessStartsAt,
        historyAccess: sessionHistoryAccessOf(row.sessionAccessStartsAt),
        effective: isEffectiveTeamMembership({
            accountStatus: row.account.status,
            membershipStatus: row.status,
            teamArchivedAt: row.team.archivedAt,
        }),
    };
}

function projectExternalKeyGroupMemberships(row: ExternalKeyMembershipRow): readonly TeamGroupMembershipLifetimeContext[] {
    return row.groupMemberships.map((membership) => ({
        teamId: membership.group.teamId,
        teamGroupId: membership.teamGroupId,
        teamMembershipId: row.id,
        accountId: row.accountId,
        nativeContribution: membership.nativeContribution,
        sessionAccessStartsAt: membership.sessionAccessStartsAt,
        historyAccess: sessionHistoryAccessOf(membership.sessionAccessStartsAt),
        effective: isEffectiveTeamGroupMembership({
            accountStatus: row.account.status,
            membershipStatus: row.status,
            teamArchivedAt: row.team.archivedAt,
            groupArchivedAt: membership.group.archivedAt,
        }),
    }));
}

async function retainResourcesWithCurrentExternalApiKeyInTx(
    tx: Tx,
    rows: readonly ResourceRow[],
    now: Date,
): Promise<Readonly<{ rows: readonly ResourceRow[]; audiences: Map<string, ResourceAudience> }>> {
    const resourceIds = rows.map((row) => row.id);
    if (resourceIds.length === 0) return { rows: [], audiences: new Map() };
    const custodianPairs = [...new Map(rows.map((row) => [
        `${row.teamId}\u0000${row.custodianAccountId}`,
        { teamId: row.teamId, accountId: row.custodianAccountId },
    ])).values()];
    const membershipSelect = {
        id: true,
        teamId: true,
        accountId: true,
        role: true,
        status: true,
        sessionAccessStartsAt: true,
        account: { select: { status: true } },
        team: { select: { archivedAt: true } },
        groupMemberships: {
            select: {
                teamGroupId: true,
                nativeContribution: true,
                sessionAccessStartsAt: true,
                group: { select: { teamId: true, archivedAt: true } },
            },
        },
    } as const;
    const [audiences, keys, custodianMembershipRows] = await Promise.all([
        readAudiencesInTx(tx, resourceIds),
        tx.teamCredentialExternalApiKey.findMany({
            where: {
                resourceId: { in: resourceIds },
                OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
            },
            select: { resourceId: true, membership: { select: membershipSelect } },
        }),
        tx.teamMembership.findMany({
            where: { OR: custodianPairs },
            select: membershipSelect,
        }),
    ]);
    const custodianMemberships = new Map(custodianMembershipRows.map((row) => [
        `${row.teamId}\u0000${row.accountId}`,
        projectExternalKeyMembership(row),
    ]));
    const membershipsByResource = new Map<string, Map<string, ExternalKeyMembershipRow>>();
    for (const key of keys) {
        const memberships = membershipsByResource.get(key.resourceId) ?? new Map<string, ExternalKeyMembershipRow>();
        memberships.set(key.membership.id, key.membership);
        membershipsByResource.set(key.resourceId, memberships);
    }
    return {
        rows: rows.filter((row) => {
            if (!row.enabled || row.sessionUsePolicy !== "personal_allowed") return false;
            const audience = audiences.get(row.id) ?? NO_AUDIENCE;
            const custodianMembership = custodianMemberships.get(`${row.teamId}\u0000${row.custodianAccountId}`) ?? null;
            return [...(membershipsByResource.get(row.id)?.values() ?? [])].some((membershipRow) => {
                const entitlement = projectTeamCredentialEntitlement({
                    resource: {
                        ...row,
                        groupGrants: audience.groupGrants,
                        memberGrants: audience.memberGrants,
                    },
                    membership: projectExternalKeyMembership(membershipRow),
                    custodianMembership,
                    groupMemberships: projectExternalKeyGroupMemberships(membershipRow),
                });
                return entitlement.ok && entitlement.mayBroker;
            });
        }),
        audiences,
    };
}

type BrokerPresentationChoices = Readonly<{
    eligibleTargets: readonly Readonly<{
        machineId: string;
        displayName: null;
        availability: "not_verified" | "update_required";
    }>[];
    eligiblePools: readonly Readonly<{
        poolId: string;
        displayName: string;
        availability: "not_verified";
        availableMachineCount: null;
    }>[];
}>;

export async function projectTeamCredentialBrokerPresentationInTx(tx: Tx, accountId: string) {
    const presentations = await projectTeamCredentialBrokerPresentationsInTx(tx, [accountId]);
    return presentations.get(accountId) ?? { eligibleTargets: [], eligiblePools: [] };
}

async function projectTeamCredentialBrokerPresentationsInTx(tx: Tx, accountIds: readonly string[]) {
    const uniqueAccountIds = [...new Set(accountIds)];
    if (uniqueAccountIds.length === 0) {
        return new Map<string, BrokerPresentationChoices>();
    }
    const [machines, pools] = await Promise.all([
        tx.machine.findMany({
            where: { accountId: { in: uniqueAccountIds }, revokedAt: null, replacedByMachineId: null },
            select: { id: true, accountId: true, kind: true, revokedAt: true, replacedByMachineId: true, operationProtocolCapabilities: true, operationProtocolCapabilitiesRevision: true },
            orderBy: [{ accountId: "asc" }, { id: "asc" }],
        }),
        tx.machinePool.findMany({
            where: { accountId: { in: uniqueAccountIds } },
            select: { id: true, accountId: true, name: true },
            orderBy: [{ accountId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        }),
    ]);
    const result = new Map<string, {
        eligibleTargets: { machineId: string; displayName: null; availability: "not_verified" | "update_required" }[];
        eligiblePools: { poolId: string; displayName: string; availability: "not_verified"; availableMachineCount: null }[];
    }>();
    for (const accountId of uniqueAccountIds) {
        result.set(accountId, { eligibleTargets: [], eligiblePools: [] });
    }
    for (const machine of machines) {
        const presentation = result.get(machine.accountId);
        if (!presentation) continue;
        const projected = (() => {
            const eligibility = classifyTeamCredentialBrokerMachineEligibility(machine);
            return eligibility === 'ineligible' ? null : {
                machineId: machine.id,
                displayName: null,
                availability: eligibility === 'eligible' ? 'not_verified' as const : 'update_required' as const,
            };
        })();
        if (projected) presentation.eligibleTargets.push(projected);
    }
    for (const pool of pools) {
        result.get(pool.accountId)?.eligiblePools.push({
            poolId: pool.id,
            displayName: pool.name,
            availability: 'not_verified',
            availableMachineCount: null,
        });
    }
    return result;
}

async function resolveProjectionStatusInTx(
    tx: Tx,
    row: ResourceRow,
    source: ReturnType<typeof TeamCredentialSourceBindingV1Schema.parse> | null,
    brokerPresentation?: BrokerPresentationChoices,
    sourceResolution?: TeamCredentialResourceSourceResolution | null,
) {
    if (source === null) return { readiness: { kind: "resource_corrupt" } as const, recoveryAction: "source_owner_action" as const };
    if (!row.enabled) return { readiness: { kind: "resource_unavailable" } as const, recoveryAction: "choose_another_resource" as const };
    const resolved = sourceResolution ?? await resolveTeamCredentialResourceSourceInTx(tx, {
        custodianAccountId: row.custodianAccountId,
        source,
    });
    if (resolved.status !== "current") {
        return { readiness: { kind: "source_unavailable" } as const, recoveryAction: "source_owner_action" as const };
    }
    if (source.kind === "provider_connection") {
        return { readiness: { kind: "resource_unavailable" } as const, recoveryAction: "choose_another_resource" as const };
    }
    if (row.disclosureCeiling === "direct_allowed") {
        return { readiness: { kind: "available" } as const, recoveryAction: null };
    }
    const placement = readTeamCredentialBrokerPlacement(row);
    if (!placement.ok) {
        return { readiness: { kind: "resource_corrupt" } as const, recoveryAction: "source_owner_action" as const };
    }
    if (placement.placement === null) {
        return { readiness: { kind: "broker_unavailable" } as const, recoveryAction: "select_broker" as const };
    }
    if (placement.placement.kind === "machine_pool") {
        if (brokerPresentation) {
            return brokerPresentation.eligiblePools.some(pool => pool.poolId === row.brokerPoolId)
                ? { readiness: { kind: "broker_unavailable", reason: "projection_unavailable" } as const, recoveryAction: "retry" as const }
                : { readiness: { kind: "broker_unavailable" } as const, recoveryAction: "select_broker" as const };
        }
        const pool = await tx.machinePool.findFirst({
            where: { id: placement.placement.poolId, accountId: row.custodianAccountId }, select: { id: true },
        });
        return pool
            ? { readiness: { kind: "broker_unavailable", reason: "projection_unavailable" } as const, recoveryAction: "retry" as const }
            : { readiness: { kind: "broker_unavailable" } as const, recoveryAction: "select_broker" as const };
    }
    if (!row.brokerMachineId) {
        return { readiness: { kind: "broker_unavailable" } as const, recoveryAction: "select_broker" as const };
    }
    if (brokerPresentation) {
        const selected = brokerPresentation.eligibleTargets.find(target => target.machineId === row.brokerMachineId);
        if (!selected) return { readiness: { kind: "broker_unavailable" } as const, recoveryAction: "select_broker" as const };
        if (selected.availability === "update_required") {
            return { readiness: { kind: "update_required" } as const, recoveryAction: "update_required" as const };
        }
        return { readiness: { kind: "broker_unavailable", reason: "projection_unavailable" } as const, recoveryAction: "retry" as const };
    }
    const selected = await tx.machine.findFirst({
        where: { id: row.brokerMachineId, accountId: row.custodianAccountId, revokedAt: null, replacedByMachineId: null },
        select: {
            kind: true,
            revokedAt: true,
            replacedByMachineId: true,
            operationProtocolCapabilities: true,
            operationProtocolCapabilitiesRevision: true,
        },
    });
    if (!selected) return { readiness: { kind: "broker_unavailable" } as const, recoveryAction: "select_broker" as const };
    if (classifyTeamCredentialBrokerMachineEligibility(selected) === "update_required") {
        return { readiness: { kind: "update_required" } as const, recoveryAction: "update_required" as const };
    }
    return { readiness: { kind: "broker_unavailable", reason: "projection_unavailable" } as const, recoveryAction: "retry" as const };
}

type ResourceAdministrationAuthority = Readonly<{
    isQualifiedTeamManager: boolean;
    isQualifiedTeamMember: boolean;
}>;

type ResourceListFacts = Readonly<{
    sourceOwnerDisplayName?: string | null;
    activeUsageLimitCount?: number;
    brokerPresentation?: BrokerPresentationChoices;
    sourceResolution?: TeamCredentialResourceSourceResolution | null;
}>;

async function projectSummary(
    tx: Tx,
    row: ResourceRow,
    audience: ResourceAudience,
    viewerAccountId: string,
    authority: ResourceAdministrationAuthority,
    listFacts: ResourceListFacts = {},
) {
    const parsedSource = readTeamCredentialSourceBinding(row.sourceBindingJson);
    let source = parsedSource.success ? parsedSource.data : null;
    let requestPolicyValue: unknown = null;
    let corrupt = false;
    try {
        if (parsedSource.success || parsedSource.reason !== 'invalid_json') {
            requestPolicyValue = row.requestPolicyJson === null ? null : JSON.parse(row.requestPolicyJson);
        }
    } catch {
        corrupt = true;
        source = null;
        requestPolicyValue = null;
    }
    const parsedRequestPolicy = TeamCredentialResourceSummaryV1Schema.shape.requestPolicy.safeParse(requestPolicyValue);
    const parsedCeiling = TeamCredentialDisclosureCeilingV1Schema.safeParse(row.disclosureCeiling);
    const parsedSessionPolicy = TeamCredentialSessionUsePolicyV1Schema.safeParse(row.sessionUsePolicy);
    const parsedAllMembersMode = row.allMembersDeliveryMode === null
        ? { success: true as const, data: null }
        : TeamCredentialDeliveryModeV1Schema.safeParse(row.allMembersDeliveryMode);
    const groupGrants = audience.groupGrants.flatMap((grant) => {
        const parsed = TeamCredentialResourceAudienceGrantV1Schema.safeParse(grant);
        if (!parsed.success) {
            corrupt = true;
            return [];
        }
        return [parsed.data];
    });
    const memberGrants = audience.memberGrants.flatMap((grant) => {
        const parsed = TeamCredentialResourceMemberGrantV1Schema.safeParse(grant);
        if (!parsed.success) {
            corrupt = true;
            return [];
        }
        return [parsed.data];
    });
    corrupt ||= !parsedSource.success
        || !parsedRequestPolicy.success
        || !parsedCeiling.success
        || !parsedSessionPolicy.success
        || !parsedAllMembersMode.success;
    // The strict administration wire shape predates row-corruption projection.
    // Its closed policy fields therefore need conservative carrier values for a
    // corrupt row. `readiness: resource_corrupt` is the deciding fact: none of
    // these carrier values may authorize, enable, or default the stored row.
    const sourceResolution = source === null
        ? null
        : listFacts.sourceResolution ?? await resolveTeamCredentialResourceSourceInTx(tx, {
            custodianAccountId: row.custodianAccountId,
            source,
        });
    const status = corrupt
        ? { readiness: { kind: "resource_corrupt" } as const, recoveryAction: "source_owner_action" as const }
        : await resolveProjectionStatusInTx(tx, row, source, listFacts.brokerPresentation, sourceResolution);
    const sourceOwnerView = viewerAccountId === row.custodianAccountId;
    const directExportSupport = sourceResolution === null
        ? "unsupported" as const
        : sourceResolution.status === "current"
            ? sourceResolution.directExportSupport
            : "unsupported" as const;
    const placementRead = readTeamCredentialBrokerPlacement(row);
    const placement = placementRead.ok ? placementRead.placement : null;
    const brokerChoices = sourceOwnerView
        ? listFacts.brokerPresentation ?? await projectTeamCredentialBrokerPresentationInTx(tx, row.custodianAccountId)
        : { eligibleTargets: [], eligiblePools: [] };
    const selectedPool = !sourceOwnerView || row.brokerPoolId === null ? null
        : listFacts.brokerPresentation
            ? listFacts.brokerPresentation.eligiblePools.find(pool => pool.poolId === row.brokerPoolId) ?? null
            : (await tx.machinePool.findFirst({
                where: { id: row.brokerPoolId, accountId: row.custodianAccountId },
                select: { id: true, name: true },
            })) satisfies { id: string; name: string } | null;
    const result = TeamCredentialResourceSummaryV1Schema.safeParse({
        id: row.id,
        teamId: row.teamId,
        custodianAccountId: row.custodianAccountId,
        sourceOwnerDisplayName: listFacts.sourceOwnerDisplayName ?? null,
        displayName: row.displayName,
        enabled: row.enabled,
        revision: row.revision,
        disclosureCeiling: parsedCeiling.success ? parsedCeiling.data : "brokered_only",
        sessionUsePolicy: authority.isQualifiedTeamManager && parsedSessionPolicy.success
            ? parsedSessionPolicy.data
            : "personal_allowed",
        source: sourceOwnerView ? source : null,
        sourcePresentation: source === null || source.kind === "provider_connection"
            ? null
            : {
                kind: "connected_service",
                service: source.kind === "connected_account" ? source.target.account.service : source.target.service,
            },
        directExportSupport,
        requestPolicy: authority.isQualifiedTeamManager && parsedRequestPolicy.success
            ? parsedRequestPolicy.data
            : null,
        brokerPlacement: sourceOwnerView ? placement : null,
        allMembersDeliveryMode: authority.isQualifiedTeamManager && parsedAllMembersMode.success
            ? parsedAllMembersMode.data
            : null,
        groupGrants: authority.isQualifiedTeamManager ? groupGrants : [],
        memberGrants: authority.isQualifiedTeamManager ? memberGrants : [],
        usageCapabilities: resolveCurrentTeamCredentialUsageCapabilitiesForResource({
            allMembersDeliveryMode: row.allMembersDeliveryMode,
            groupGrants,
            memberGrants,
            sessionUsePolicy: row.sessionUsePolicy,
        }),
        activeUsageLimitCount: listFacts.activeUsageLimitCount ?? 0,
        readiness: status.readiness,
        recoveryAction: status.recoveryAction,
        brokerPresentation: {
            selectedTarget: brokerChoices.eligibleTargets.find(target => target.machineId === row.brokerMachineId) ?? null,
            eligibleTargets: brokerChoices.eligibleTargets,
            selectedPool: selectedPool === null ? null
                : 'poolId' in selectedPool ? selectedPool : {
                    poolId: selectedPool.id,
                    displayName: selectedPool.name,
                    availability: "not_verified",
                    availableMachineCount: null,
                },
            eligiblePools: brokerChoices.eligiblePools,
        },
        capabilities: projectTeamCredentialResourceAdministrationCapabilities({
            resource: {
                enabled: row.enabled,
                disclosureCeiling: parsedCeiling.success ? parsedCeiling.data : "brokered_only",
            },
            isSourceCustodian: sourceOwnerView,
            isQualifiedTeamManager: authority.isQualifiedTeamManager,
            isQualifiedTeamMember: authority.isQualifiedTeamMember,
        }),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
    });
    return result.success ? { ok: true as const, resource: result.data } : { ok: false as const, issues: result.error.issues };
}

export async function projectTeamCredentialResourceSummaryInTx(tx: Tx, resourceId: string, viewerAccountId: string) {
    const row = await tx.teamCredentialResource.findUnique({ where: { id: resourceId } });
    if (!row) return { ok: false as const, error: "resource_not_found" as const };
    const audience = (await readAudiencesInTx(tx, [resourceId])).get(resourceId) ?? NO_AUDIENCE;
    const actor = await resolveTeamActorContextInTx(tx, { teamId: row.teamId, actorAccountId: viewerAccountId });
    const projected = await projectSummary(tx, row, audience, viewerAccountId, {
        isQualifiedTeamManager: actor !== null
            && resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt }).manageCredentials,
        isQualifiedTeamMember: actor?.capabilities.viewTeam === true,
    });
    return projected.ok
        ? projected
        : { ok: false as const, error: "resource_corrupt" as const, issues: projected.issues };
}

export type TeamCredentialCatalogProjectionRequest = Readonly<{
    resourceId: string;
    teamId: string;
    resourceRevision: number;
    custodianAccountId: string;
    brokerMachineId: string | null;
    brokerPoolId: string | null;
    source: ReturnType<typeof TeamCredentialSourceBindingV1Schema.parse>;
    allowedModelIds: readonly string[] | null;
    deliveryMode: 'brokered' | 'direct';
    directMaterialReferences: readonly Readonly<{ sourceMemberKey: string; sourceVersion: string }>[];
}>;

async function readCurrentDirectMaterialReferencesInTx(
    tx: Tx,
    row: ResourceRow,
    actorAccountId: string,
    source: ReturnType<typeof TeamCredentialSourceBindingV1Schema.parse> | null,
) {
    const [materials, recipient, sourceMembers] = await Promise.all([
        tx.teamCredentialRecipientMaterial.findMany({
            where: { resourceId: row.id, recipientAccountId: actorAccountId },
            select: {
                sourceMemberKey: true,
                sourceVersion: true,
                recipientMode: true,
                recipientContentPublicKeyFingerprint: true,
            },
        }),
        tx.account.findUnique({
            where: { id: actorAccountId },
            select: { publicKey: true, encryptionMode: true, contentPublicKey: true, contentPublicKeySig: true },
        }),
        source === null ? Promise.resolve(null) : listTeamCredentialDirectSourceMembersInTx(tx, {
            custodianAccountId: row.custodianAccountId,
            source,
        }),
    ]);
    const recipientBinding = recipient === null ? null : deriveAccountEncryptionCurrentnessFromRow(recipient);
    const published = parsePublishedTeamCredentialSourceVersions(row.directSourceVersionsJson);
    const currentMembersByKey = new Map((sourceMembers ?? []).map((member) => [
        computeTeamCredentialSourceMemberKeyV1(member),
        member,
    ]));
    const currentSourceVersions = new Map<string, string | null>();
    if (source !== null) {
        for (const memberKey of currentMembersByKey.keys()) {
            const currentness = await resolveTeamCredentialSourceMemberCurrentnessInTx(tx, {
                deliveryMode: 'direct',
                custodianAccountId: row.custodianAccountId,
                source,
                sourceMemberKey: memberKey,
            });
            if (currentness.status === "current") {
                currentSourceVersions.set(memberKey, currentness.sourceVersion);
            }
        }
    }
    // The custodian publishes a source version per member the moment direct
    // delivery is configured, so a published set with no envelope for this
    // recipient yet is "preparing", not "never delivered".
    const publishedForDirect = published !== null && Object.keys(published).length > 0;
    if (recipientBinding?.status !== 'ready' || published === null) {
        return { current: [], materialCount: materials.length, publishedForDirect };
    }
    const recipientCurrentness = recipientBinding.currentness;
    const current = materials.filter((material) => (
        currentMembersByKey.has(material.sourceMemberKey)
        && published[material.sourceMemberKey] === material.sourceVersion
        && currentSourceVersions.has(material.sourceMemberKey)
        && (currentSourceVersions.get(material.sourceMemberKey) === null
            || matchesTeamCredentialSourceVersionBasisV1(material.sourceVersion,
                currentSourceVersions.get(material.sourceMemberKey)!))
        && matchesTeamCredentialRecipientBinding(material, recipientCurrentness)
    )).flatMap(({ sourceMemberKey, sourceVersion }) => {
        const member = currentMembersByKey.get(sourceMemberKey);
        return member?.kind === "connected_account"
            ? [{
                sourceMemberKey,
                sourceVersion,
                disclosedMember: {
                    service: member.service,
                    accountId: member.connectedAccountId,
                },
            }]
            : member
                ? [{ sourceMemberKey, sourceVersion }]
                : [];
    });
    return { current, materialCount: materials.length, publishedForDirect };
}

function projectCurrentDirectMaterialReferences(input: Readonly<{
    row: ResourceRow;
    source: ReturnType<typeof TeamCredentialSourceBindingV1Schema.parse> | null;
    sourceResolution: TeamCredentialResourceSourceResolution | null;
    materials: readonly Readonly<{ sourceMemberKey: string; sourceVersion: string; recipientMode: string; recipientContentPublicKeyFingerprint: string | null }>[];
    recipientBinding: ReturnType<typeof deriveAccountEncryptionCurrentnessFromRow> | null;
}>) {
    const published = parsePublishedTeamCredentialSourceVersions(input.row.directSourceVersionsJson);
    const publishedForDirect = published !== null && Object.keys(published).length > 0;
    const recipientBinding = input.recipientBinding;
    if (recipientBinding?.status !== 'ready' || published === null || input.source === null) {
        return { current: [], materialCount: input.materials.length, publishedForDirect };
    }
    const currentByKey = new Map(projectTeamCredentialDirectSourceCurrentnesses(input.source, input.sourceResolution).map(current => [
        computeTeamCredentialSourceMemberKeyV1(current.sourceMember), current,
    ]));
    return {
        current: input.materials.flatMap(material => {
            const current = currentByKey.get(material.sourceMemberKey);
            if (!current || published[material.sourceMemberKey] !== material.sourceVersion
                || (current.sourceVersion !== null && !matchesTeamCredentialSourceVersionBasisV1(material.sourceVersion, current.sourceVersion))
                || !matchesTeamCredentialRecipientBinding(material, recipientBinding.currentness)) return [];
            return [{ sourceMemberKey: material.sourceMemberKey, sourceVersion: material.sourceVersion,
                ...(current.sourceMember.kind === 'connected_account' ? { disclosedMember: {
                    service: current.sourceMember.service, accountId: current.sourceMember.connectedAccountId,
                } } : {}) }];
        }),
        materialCount: input.materials.length,
        publishedForDirect,
    };
}

async function projectCatalogEntryInTx(
    tx: Tx,
    row: ResourceRow,
    source: TeamCredentialSourceBindingV1 | null,
    audience: ResourceAudience,
    actorAccountId: string,
    prefetchedSourceResolution?: TeamCredentialResourceSourceResolution | null,
    prefetchedEntitlement?: Awaited<ReturnType<typeof resolveTeamCredentialEntitlementInTx>>,
    prefetchedAudienceMatch?: boolean,
    captureProjectionFacts?: (facts: Readonly<{
        entitlement: Extract<Awaited<ReturnType<typeof resolveTeamCredentialEntitlementInTx>>, { ok: true }>;
        source: ReturnType<typeof TeamCredentialSourceBindingV1Schema.parse> | null;
        sessionUsePolicyValid: boolean;
        directMaterialReferences: readonly Readonly<{ sourceMemberKey: string; sourceVersion: string }>[];
    }>) => void,
    prefetchedUsageEvaluation?: TeamCredentialUsageAdmissionLimitEvaluation | null,
    prefetchedDirectMaterial?: ReturnType<typeof projectCurrentDirectMaterialReferences>,
    prefetchedWasDirectlyDelivered?: boolean,
) {
    const usageCapabilities = resolveCurrentTeamCredentialUsageCapabilitiesForResource({
        allMembersDeliveryMode: row.allMembersDeliveryMode,
        groupGrants: audience.groupGrants,
        memberGrants: audience.memberGrants,
        sessionUsePolicy: row.sessionUsePolicy,
    });

    const projectCorruptCatalogEntry = () => TeamCredentialResourceCatalogEntryV1Schema.parse({
        id: row.id,
        teamId: row.teamId,
        displayName: row.displayName,
        resourceRevision: row.revision,
        readiness: { kind: "resource_corrupt" },
        recoveryAction: "source_owner_action",
        mayBroker: false,
        mayReceiveDirect: false,
        directMaterialState: "revoked",
        sessionUsePolicy: null,
        providerModels: [],
        connectedServiceSelections: [],
        sourcePresentation: null,
        usageCapabilities,
    });

    const entitlement = prefetchedEntitlement ?? await resolveTeamCredentialEntitlementInTx(tx, { resourceId: row.id, accountId: actorAccountId });
    if (!entitlement.ok) {
        if ((entitlement.reason !== "resource_corrupt" && entitlement.reason !== "source_owner_required")
            || !(prefetchedAudienceMatch ?? await hasCurrentTeamCredentialAudienceMatchInTx(tx, { resourceId: row.id, accountId: actorAccountId }))) return null;
        const policy = TeamCredentialResourceCatalogEntryV1Schema.shape.sessionUsePolicy.safeParse(row.sessionUsePolicy);
        const projected = TeamCredentialResourceCatalogEntryV1Schema.safeParse({
            id: row.id,
            teamId: row.teamId,
            displayName: row.displayName,
            resourceRevision: row.revision,
            readiness: entitlement.reason === "resource_corrupt"
                ? { kind: "resource_corrupt" }
                : { kind: "source_unavailable" },
            recoveryAction: "source_owner_action",
            mayBroker: false,
            mayReceiveDirect: false,
            directMaterialState: "revoked",
            sessionUsePolicy: policy.success ? policy.data : null,
            providerModels: [],
            sourcePresentation: entitlement.reason === "resource_corrupt" || source === null
                ? null
                : source.kind === "provider_connection"
                    ? null
                    : {
                        kind: "connected_service",
                        service: source.kind === "connected_account" ? source.target.account.service : source.target.service,
                    },
            usageCapabilities,
        });
        return projected.success ? projected.data : projectCorruptCatalogEntry();
    }

    const policy = TeamCredentialResourceCatalogEntryV1Schema.shape.sessionUsePolicy.safeParse(row.sessionUsePolicy);
    const usageEvaluation = entitlement.mayBroker ? prefetchedUsageEvaluation ?? null : null;
    const usageLimit = usageEvaluation && !usageEvaluation.ok && 'denied' in usageEvaluation
        ? {
            metric: usageEvaluation.denied.metric,
            remaining: '0' as const,
            resetsAtUtc: usageEvaluation.denied.resetsAt.toISOString(),
        }
        : null;
    const sourceResolution = source === null ? null : prefetchedSourceResolution ?? await resolveTeamCredentialResourceSourceInTx(tx, {
        custodianAccountId: row.custodianAccountId,
        source,
    });
    // A reached allowance is the recipient-visible readiness for this route, not
    // a silent `available`: the limit owner already resolved the exact metric and
    // reset, and the picker renders both. It stays behind the structural reasons
    // above, which no retry can clear.
    const readiness = source === null || !policy.success
        || (sourceResolution?.status === "unavailable" && sourceResolution.reason === "invalid_source_binding")
        ? { kind: "resource_corrupt" as const }
        : sourceResolution?.status === "unavailable"
            ? { kind: "source_unavailable" as const }
            : source?.kind === 'provider_connection'
                ? { kind: "source_unavailable" as const }
                : usageLimit
                    ? {
                        kind: "limit_reached" as const,
                        metric: usageLimit.metric,
                        resetsAtUtc: usageLimit.resetsAtUtc,
                    }
                    : { kind: "available" as const };
    const recoveryAction = readiness.kind === "available" ? null
        : readiness.kind === "source_unavailable" ? "source_owner_action" as const
            : readiness.kind === "resource_corrupt" ? "source_owner_action" as const
                : readiness.kind === "limit_reached" ? "retry" as const
                    : "choose_another_resource" as const;
    let directMaterialState: "revoked" | "never_delivered" | "preparing" | "current" | "stale" = "revoked";
    // Retained first-disclosure history, kept apart from readiness: a
    // custodian prepares a tuple before the recipient ever opens it, so
    // `current` alone says nothing about what was already disclosed.
    let directDeliveryRecorded = false;
    let currentDirectReferences: readonly Readonly<{
        sourceMemberKey: string;
        sourceVersion: string;
        disclosedMember?: Readonly<{
            service: Readonly<{ pluginId: string; localId: string }>;
            accountId: string;
        }>;
    }>[] = [];
    if (entitlement.mayReceiveDirect) {
        const [material, wasDirectlyDelivered] = prefetchedDirectMaterial ? [
            prefetchedDirectMaterial, prefetchedWasDirectlyDelivered ?? false,
        ] : await Promise.all([
            readCurrentDirectMaterialReferencesInTx(tx, row, actorAccountId, source),
            hasTeamCredentialDirectDeliveryActivityInTx(tx, {
                resourceId: row.id,
                recipientAccountId: actorAccountId,
            }),
        ]);
        currentDirectReferences = material.current;
        directDeliveryRecorded = wasDirectlyDelivered;
        directMaterialState = material.current.length > 0
            ? "current"
            : material.materialCount > 0 || wasDirectlyDelivered
                ? "stale"
                // The custodian has published this resource's direct source
                // versions, so envelopes for this recipient are owed and on the
                // way: "preparing", not "never delivered".
                : material.publishedForDirect
                    ? "preparing"
                    : "never_delivered";
    }
    const placementRead = readTeamCredentialBrokerPlacement(row);
    const hasBrokerPlacement = placementRead.ok && placementRead.placement !== null;
    captureProjectionFacts?.({ entitlement, source, sessionUsePolicyValid: policy.success, directMaterialReferences: currentDirectReferences });
    const projected = TeamCredentialResourceCatalogEntryV1Schema.safeParse({
        id: row.id,
        teamId: row.teamId,
        displayName: row.displayName,
        resourceRevision: row.revision,
        readiness,
        recoveryAction,
        // Entitlement rights remain independent of route readiness. The
        // route-specific rows below decide whether either path is currently
        // selectable; a stale direct route must not erase broker authority,
        // and an unavailable broker must not erase direct authority.
        mayBroker: entitlement.mayBroker,
        mayReceiveDirect: entitlement.mayReceiveDirect,
        deliveryPolicy: entitlement.deliveryPolicy,
        allowedRoutes: entitlement.allowedRoutes,
        directMaterialState,
        ...(directDeliveryRecorded ? { directDeliveryRecorded: true } : {}),
        sessionUsePolicy: policy.success ? policy.data : null,
        providerModels: [],
        // A reached allowance does not unselect the route: the recipient keeps the
        // row, sees when it resets, and the next request is refused by the one
        // admission owner rather than by a hidden catalog.
        connectedServiceSelections: readiness.kind === "available" || readiness.kind === "limit_reached"
            ? [
                ...(entitlement.mayBroker && hasBrokerPlacement ? [{
                    source: "team_resource" as const,
                    resourceId: row.id,
                    deliveryMode: "brokered" as const,
                }] : []),
                ...currentDirectReferences.flatMap((reference) => reference.disclosedMember ? [{
                    source: "team_resource" as const,
                    resourceId: row.id,
                    deliveryMode: "direct" as const,
                    disclosedMember: reference.disclosedMember,
                }] : []),
            ]
            : [],
        sourcePresentation: source === null ? null : source.kind === "provider_connection"
            ? null
            : {
                kind: "connected_service",
                service: source.kind === "connected_account" ? source.target.account.service : source.target.service,
        },
        usageCapabilities,
        ...(usageLimit ? { usageLimit } : {}),
    });
    return projected.success ? projected.data : projectCorruptCatalogEntry();
}

function credentialQualificationError(error: "team_authentication_required" | "team_authentication_unavailable") {
    return error === "team_authentication_required"
        ? "team_authentication_required" as const
        : "team_authentication_policy_unavailable" as const;
}

export async function qualifyTeamCredentialOperationInTx(
    tx: Tx,
    actor: NonNullable<Awaited<ReturnType<typeof resolveTeamActorContextInTx>>>,
    authentication: TeamOperationAuthenticationContext,
) {
    const result = await qualifyTeamOperationAuthenticationInTx(tx, { context: actor, ...authentication });
    return result.ok ? result : { ok: false as const, error: credentialQualificationError(result.error) };
}

async function qualifyTeamCredentialOperationsInTx(
    tx: Tx,
    actors: readonly NonNullable<Awaited<ReturnType<typeof resolveTeamActorContextInTx>>>[],
    authentication: TeamOperationAuthenticationContext,
) {
    const results = await qualifyTeamOperationAuthenticationsInTx(tx, {
        contexts: actors,
        ...authentication,
    });
    return new Map([...results].map(([teamId, result]) => [
        teamId,
        result.ok ? result : { ok: false as const, error: credentialQualificationError(result.error) },
    ]));
}

type CredentialReadInput = Readonly<{
    teamId: string;
    actorAccountId: string;
    authentication: TeamOperationAuthenticationContext;
    application?: ProviderBrokerApplicationBindingV1;
    cursor?: string;
    limit?: number;
    search?: string;
    filter?: 'all' | 'needs_attention' | 'brokered' | 'direct' | 'external_api';
}>;

export async function readTeamCredentialCatalogInTx(tx: Tx, input: CredentialReadInput) {
    const actor = await resolveTeamActorContextInTx(tx, input);
    if (!actor?.capabilities.viewTeam) return { ok: false as const, error: "not_found_or_not_visible" as const };
    const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, input.authentication);
    if (!qualification.ok) return qualification;
    const queryKey = `v1:credential-recipient:${input.teamId}:${input.application ? JSON.stringify(input.application) : ''}`;
    return readAdmittedTeamCredentialCatalogInTx(tx, { ...input, teamIds: [input.teamId], queryKey });
}

/** One Account/application read; the existing authority and qualification owners decide every Team. */
export async function readTeamCredentialDiscoveryInTx(tx: Tx, input: Omit<CredentialReadInput, 'teamId'> & Readonly<{
    teamIds: readonly string[];
}>) {
    const teamIds = [...new Set(input.teamIds)];
    const actors = await resolveTeamActorContextsInTx(tx, { teamIds, actorAccountId: input.actorAccountId });
    const visible = teamIds.flatMap(teamId => {
        const actor = actors.get(teamId);
        return actor?.capabilities.viewTeam ? [actor] : [];
    });
    const qualifications = await qualifyTeamCredentialOperationsInTx(tx, visible, input.authentication);
    const admittedTeamIds: string[] = [];
    const failures: Array<{ teamId: string; error: TeamCredentialErrorCodeV1 }> = [];
    for (const teamId of teamIds) {
        const actor = actors.get(teamId);
        if (!actor?.capabilities.viewTeam) {
            failures.push({ teamId, error: 'not_found_or_not_visible' });
            continue;
        }
        const qualification = qualifications.get(teamId);
        if (!qualification?.ok) {
            failures.push({ teamId, error: qualification?.error ?? 'team_authentication_policy_unavailable' });
            continue;
        }
        admittedTeamIds.push(teamId);
    }
    const result = await readAdmittedTeamCredentialCatalogInTx(tx, {
        ...input, teamIds: admittedTeamIds,
        queryKey: `v1:credential-discovery:${JSON.stringify([...teamIds].sort())}:${input.application ? JSON.stringify(input.application) : ''}`,
    });
    return result.ok ? { ...result, page: { ...result.page, failures } } : result;
}

/** Both recipient operations share the same current entitlement/material/source projection. */
async function readAdmittedTeamCredentialCatalogInTx(tx: Tx, input: Omit<CredentialReadInput, 'teamId'> & Readonly<{
    teamIds: readonly string[];
    queryKey: string;
}>) {
    const limit = input.limit ?? 50;
    const queryKey = input.queryKey;
    const decoded = input.cursor ? decodeTeamCredentialResourcesCursorV1(input.cursor, queryKey) : null;
    if (decoded?.status === 'invalid') return { ok: false as const, error: 'invalid_resource_input' as const };
    const after = decoded?.status === 'ok' ? decoded.cursor : null;
    const projected: Array<{ row: ResourceRow; resource: NonNullable<Awaited<ReturnType<typeof projectCatalogEntryInTx>>> }> = [];
    const projectionFactsByResourceId = new Map<string, Parameters<NonNullable<Parameters<typeof projectCatalogEntryInTx>[8]>>[0]>();
    let candidateWindow: ResourceRow[] = [];
    // Retain only the leading page between bind chunks. The database orders the
    // union, preserving its collation and keyset semantics on every provider.
    for (const teamIds of portableQueryChunks({ values: input.teamIds, bindingsPerValue: 1,
        fixedBindings: limit + 1 + 5 })) {
        candidateWindow = await tx.teamCredentialResource.findMany({
            where: { AND: [
                { OR: [{ teamId: { in: [...teamIds] } },
                    ...(candidateWindow.length > 0 ? [{ id: { in: candidateWindow.map(row => row.id) } }] : [])] },
                ...(after ? [{ OR: [
                    { displayName: { gt: after.displayName } },
                    { displayName: after.displayName, id: { gt: after.id } },
                ] }] : []),
            ] },
            orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: limit + 1,
        });
    }
    const hasMoreCandidates = candidateWindow.length > limit;
    const candidates = candidateWindow.slice(0, limit);
    if (candidates.length > 0) {
        const audiences = await readAudiencesInTx(tx, candidates.map(row => row.id));
        const candidateSources = candidates.map(row => {
            const parsed = readTeamCredentialSourceBinding(row.sourceBindingJson);
            return parsed.success ? parsed.data : null;
        });
        const sourceResolutions = await resolveTeamCredentialResourceSourcesInTx(tx, candidates.map((row, index) => ({
            custodianAccountId: row.custodianAccountId, source: candidateSources[index],
        })));
        const membershipAccountsByTeam = new Map<string, Set<string>>();
        for (const row of candidates) {
            const accounts = membershipAccountsByTeam.get(row.teamId) ?? new Set([input.actorAccountId]);
            accounts.add(row.custodianAccountId);
            membershipAccountsByTeam.set(row.teamId, accounts);
        }
        const [membershipRows, materialRows, recipientRow, deliveryActivityRows] = await Promise.all([tx.teamMembership.findMany({
            // At most one Team and actor bind per candidate, plus its custodian:
            // the existing 100-candidate page keeps this below the portable ceiling.
            where: { OR: [...membershipAccountsByTeam].map(([teamId, accountIds]) => ({
                teamId, accountId: { in: [...accountIds] },
            })) },
            select: {
                id: true, teamId: true, accountId: true, role: true, status: true, sessionAccessStartsAt: true,
                account: { select: { status: true } }, team: { select: { archivedAt: true } },
                groupMemberships: { select: {
                    teamGroupId: true, nativeContribution: true, sessionAccessStartsAt: true,
                    group: { select: { teamId: true, archivedAt: true } },
                } },
            },
        }), tx.teamCredentialRecipientMaterial.findMany({
            where: { resourceId: { in: candidates.map(row => row.id) }, recipientAccountId: input.actorAccountId },
            select: { resourceId: true, sourceMemberKey: true, sourceVersion: true, recipientMode: true, recipientContentPublicKeyFingerprint: true },
        }), tx.account.findUnique({
            where: { id: input.actorAccountId },
            select: { publicKey: true, encryptionMode: true, contentPublicKey: true, contentPublicKeySig: true },
        }), tx.teamCredentialActivityEvent.findMany({
            where: { resourceId: { in: candidates.map(row => row.id) }, actorAccountId: input.actorAccountId, kind: 'direct_delivered' },
            select: { resourceId: true },
        })]);
        const membershipByTeamAndAccount = new Map(membershipRows.map(row => [JSON.stringify([row.teamId, row.accountId]), row]));
        const recipientBinding = recipientRow === null ? null : deriveAccountEncryptionCurrentnessFromRow(recipientRow);
        const deliveredResourceIds = new Set(deliveryActivityRows.map(row => row.resourceId));
        const materialsByResource = new Map<string, typeof materialRows>();
        for (const material of materialRows) {
            const current = materialsByResource.get(material.resourceId) ?? [];
            current.push(material);
            materialsByResource.set(material.resourceId, current);
        }
        const candidateProjectionInputs = candidates.map((row, index) => {
            const audience = audiences.get(row.id) ?? NO_AUDIENCE;
            const actorMembershipRow = membershipByTeamAndAccount.get(JSON.stringify([row.teamId, input.actorAccountId]));
            const actorMembership = actorMembershipRow ? projectExternalKeyMembership(actorMembershipRow) : null;
            const actorGroups = actorMembershipRow ? projectExternalKeyGroupMemberships(actorMembershipRow) : [];
            const custodianRow = membershipByTeamAndAccount.get(JSON.stringify([row.teamId, row.custodianAccountId]));
            const entitlement = projectTeamCredentialEntitlement({
                resource: { ...row, groupGrants: audience.groupGrants, memberGrants: audience.memberGrants },
                membership: actorMembership,
                custodianMembership: custodianRow ? projectExternalKeyMembership(custodianRow) : null,
                groupMemberships: actorGroups,
            });
            const audienceMatch = actorMembership?.effective === true && (
                (row.allMembersDeliveryMode !== null && actorMembership.role !== 'guest')
                || audience.memberGrants.some(grant => grant.teamMembershipId === actorMembership.teamMembershipId)
                || audience.groupGrants.some(grant => actorGroups.some(group => group.effective && group.teamGroupId === grant.teamGroupId))
            );
            return { row, index, audience, entitlement, audienceMatch };
        });
        const usageEvaluations = await evaluateTeamCredentialUsageAdmissionLimitsForResourcesInTx(tx, {
            resourceIds: candidateProjectionInputs.flatMap(({ row, entitlement }) => (
                entitlement.ok && entitlement.mayBroker ? [row.id] : []
            )),
            actorAccountId: input.actorAccountId,
        });
        const page = await Promise.all(candidateProjectionInputs.map(async ({ row, index, audience, entitlement, audienceMatch }) => ({
            row,
            resource: await projectCatalogEntryInTx(
                tx,
                row,
                candidateSources[index] ?? null,
                audience,
                input.actorAccountId,
                sourceResolutions[index],
                entitlement,
                audienceMatch,
                facts => projectionFactsByResourceId.set(row.id, facts),
                usageEvaluations.get(row.id) ?? null,
                projectCurrentDirectMaterialReferences({
                    row,
                    source: candidateSources[index] ?? null,
                    sourceResolution: sourceResolutions[index] ?? null,
                    materials: materialsByResource.get(row.id) ?? [],
                    recipientBinding,
                }),
                deliveredResourceIds.has(row.id),
            ),
        })));
        projected.push(...page.flatMap(value => value.resource ? [{ row: value.row, resource: value.resource }] : []));
    }
    const selected = projected.slice(0, limit);
    const rows = selected.map(value => value.row);
    const resources = selected.map(value => value.resource);
    const lastProcessedRow = candidates.at(-1) ?? null;
    const projectionRequests: TeamCredentialCatalogProjectionRequest[] = [];
    if (input.application) {
        for (const row of rows) {
            const resource = resources.find((candidate) => candidate.id === row.id);
            if (!resource) continue;
            const facts = projectionFactsByResourceId.get(row.id);
            if (!facts || (!facts.entitlement.mayBroker && !facts.entitlement.mayReceiveDirect)) continue;
            const entitlement = facts.entitlement;
            const placementRead = readTeamCredentialBrokerPlacement(row);
            const hasBrokerPlacement = placementRead.ok && placementRead.placement !== null;
            const source = facts.source;
            if (source === null) continue;
            let policy: unknown;
            try {
                policy = row.requestPolicyJson === null ? null : JSON.parse(row.requestPolicyJson);
            } catch {
                continue;
            }
            if (!facts.sessionUsePolicyValid) continue;
            const requestPolicy = TeamCredentialResourceSummaryV1Schema.shape.requestPolicy.safeParse(policy);
            if (!requestPolicy.success) continue;
            const directMaterialReferences = entitlement.mayReceiveDirect ? facts.directMaterialReferences : [];
            const base = {
                resourceId: row.id,
                teamId: row.teamId,
                resourceRevision: row.revision,
                custodianAccountId: row.custodianAccountId,
                brokerMachineId: row.brokerMachineId,
                brokerPoolId: row.brokerPoolId,
                source,
                allowedModelIds: requestPolicy.data?.allowedModelIds ?? null,
            };
            if (entitlement.mayBroker && hasBrokerPlacement) {
                projectionRequests.push({ ...base, deliveryMode: "brokered", directMaterialReferences: [] });
            }
            if (entitlement.mayReceiveDirect) {
                projectionRequests.push({ ...base, deliveryMode: "direct", directMaterialReferences });
            }
        }
    }
    return { ok: true as const, page: {
        resources,
        nextCursor: hasMoreCandidates && lastProcessedRow ? encodeTeamCredentialResourcesCursorV1({
            queryKey, displayName: lastProcessedRow.displayName, id: lastProcessedRow.id,
        }) : null,
    }, projectionRequests };
}

export async function readTeamCredentialResourcePageInTx(tx: Tx, input: CredentialReadInput) {
    const actor = await resolveTeamActorContextInTx(tx, input);
    if (!actor?.capabilities.viewTeam) return { ok: false as const, error: "not_found_or_not_visible" as const };
    const viewer = resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt });
    const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, input.authentication);
    if (!qualification.ok) return qualification;
    const qualifiedViewer = qualification.ok ? viewer : { manageCredentials: false, offerOwnCredential: false };
    const filter = input.filter ?? 'all';
    const limit = input.limit ?? 50;
    const queryKey = teamCredentialResourcesQueryKeyV1({
        teamId: input.teamId, search: input.search, filter,
    });
    const decoded = input.cursor ? decodeTeamCredentialResourcesCursorV1(input.cursor, queryKey) : null;
    if (decoded?.status === 'invalid') return { ok: false as const, error: 'invalid_resource_input' as const };
    const after = decoded?.status === 'ok' ? decoded.cursor : null;
    const deliveryModes = filter === 'brokered'
        ? ['brokered', 'both'] as const
        : filter === 'direct'
            ? ['direct', 'both'] as const
            : null;
    const now = new Date();
    const readAdministrationCandidates = async (candidateAfter: typeof after, windowSize: number = limit) => await tx.teamCredentialResource.findMany({
        where: {
            teamId: input.teamId,
            ...(!qualifiedViewer.manageCredentials ? { custodianAccountId: input.actorAccountId } : {}),
            ...(input.search ? { displayName: { contains: input.search } } : {}),
            ...(deliveryModes ? { AND: [
                { OR: [
                    { allMembersDeliveryMode: { in: [...deliveryModes] } },
                    { groupGrants: { some: { deliveryMode: { in: [...deliveryModes] } } } },
                    { memberGrants: { some: { deliveryMode: { in: [...deliveryModes] } } } },
                ] },
                ...(candidateAfter ? [{ OR: [
                    { displayName: { gt: candidateAfter.displayName } },
                    { displayName: candidateAfter.displayName, id: { gt: candidateAfter.id } },
                ] }] : []),
            ] }
                : filter === 'external_api' ? {
                    enabled: true,
                    sessionUsePolicy: 'personal_allowed',
                    externalApiKeys: { some: {
                        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
                        membership: { status: 'active', account: { status: 'active' } },
                    } },
                }
                : {}),
            ...(!deliveryModes && candidateAfter ? { OR: [
                { displayName: { gt: candidateAfter.displayName } },
                { displayName: candidateAfter.displayName, id: { gt: candidateAfter.id } },
            ] } : {}),
        },
        orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        take: windowSize + 1,
    });
    let externalApiAudiences: Map<string, ResourceAudience> | null = null;
    let administrationRowsWithLookahead: readonly ResourceRow[];
    let hasMore: boolean;
    let lastProcessedCandidate: ResourceRow | null;
    if (filter === 'external_api') {
        // A key's current assignment is not expressible in the keyset predicate,
        // so retained rows are sparser than the candidate window. Advance through
        // bounded candidate windows until the page fills or the keyset is
        // exhausted, so the first window never answers an empty page beside a
        // cursor that still points at matching rows.
        const retained: ResourceRow[] = [];
        const retainedAudiences = new Map<string, ResourceAudience>();
        let windowAfter = after;
        let moreCandidates = false;
        let lastCandidate: ResourceRow | null = null;
        // The keyset is the bound: the walk stops when the page fills or the
        // Team's own resources are exhausted, the same storage boundary the
        // unfiltered listing already scans. A local window budget would answer
        // an empty page beside a cursor that still points at matching rows.
        //
        // The candidate window is the largest page this contract can already be
        // asked for (`TeamCredentialResourceListInputV1Schema.limit`), not the
        // caller's chosen page size, so the number of candidate reads follows
        // the Team's own keyset instead of multiplying as the requested page
        // shrinks. It is not a new bound: one request may already ask for this
        // many rows.
        while (true) {
            const candidates = await readAdministrationCandidates(windowAfter, EXTERNAL_API_CANDIDATE_WINDOW);
            moreCandidates = candidates.length > EXTERNAL_API_CANDIDATE_WINDOW;
            const processed = candidates.slice(0, EXTERNAL_API_CANDIDATE_WINDOW);
            if (processed.length === 0) break;
            const current = await retainResourcesWithCurrentExternalApiKeyInTx(tx, processed, now);
            for (const [key, value] of current.audiences) retainedAudiences.set(key, value);
            const retainedIds = new Set(current.rows.map((row) => row.id));
            let consumed = 0;
            for (const candidate of processed) {
                consumed += 1;
                lastCandidate = candidate;
                if (retainedIds.has(candidate.id)) retained.push(candidate);
                if (retained.length === limit) break;
            }
            if (consumed < processed.length) {
                moreCandidates = true;
                break;
            }
            if (retained.length === limit || !moreCandidates || lastCandidate === null) break;
            windowAfter = { displayName: lastCandidate.displayName, id: lastCandidate.id };
        }
        externalApiAudiences = retainedAudiences;
        administrationRowsWithLookahead = retained;
        hasMore = moreCandidates;
        lastProcessedCandidate = lastCandidate;
    } else {
        administrationRowsWithLookahead = await readAdministrationCandidates(after);
        hasMore = administrationRowsWithLookahead.length > limit;
        lastProcessedCandidate = administrationRowsWithLookahead.slice(0, limit).at(-1) ?? null;
    }
    const administrationRows = administrationRowsWithLookahead.slice(0, limit);
    const resourceIds = administrationRows.map(row => row.id);
    const custodianAccountIds = [...new Set(administrationRows.map(row => row.custodianAccountId))];
    const [audiences, sourceOwners, activeLimits] = await Promise.all([
        externalApiAudiences ?? readAudiencesInTx(tx, resourceIds),
        tx.account.findMany({
            where: { id: { in: custodianAccountIds } },
            select: { id: true, name: true, username: true },
        }),
        tx.teamCredentialUsageLimit.findMany({
            where: { resourceId: { in: resourceIds }, enabled: true },
            select: { resourceId: true },
        }),
    ]);
    const brokerPresentations = await projectTeamCredentialBrokerPresentationsInTx(
        tx,
        administrationRows.map(row => row.custodianAccountId),
    );
    // Resolve the page through the canonical source repositories in bounded
    // batches. Several resources can intentionally offer the same source with
    // different Team audiences/policies; currentness must not become one
    // database round-trip per presentation row.
    const parsedSources = new Map<string, ReturnType<typeof TeamCredentialSourceBindingV1Schema.parse> | null>();
    const sourceResolutionRequests: Array<Readonly<{
        resourceId: string;
        custodianAccountId: string;
        source: ReturnType<typeof TeamCredentialSourceBindingV1Schema.parse>;
    }>> = [];
    for (const row of administrationRows) {
        const parsed = readTeamCredentialSourceBinding(row.sourceBindingJson);
        const source = parsed.success ? parsed.data : null;
        parsedSources.set(row.id, source);
        if (source === null) continue;
        sourceResolutionRequests.push({
            resourceId: row.id,
            custodianAccountId: row.custodianAccountId,
            source,
        });
    }
    const resolvedSources = await resolveTeamCredentialResourceSourcesInTx(
        tx,
        sourceResolutionRequests.map(({ custodianAccountId, source }) => ({
            custodianAccountId,
            source,
        })),
    );
    const sourceResolutionByResourceId = new Map<string, TeamCredentialResourceSourceResolution>(
        sourceResolutionRequests.map((request, index) => [
            request.resourceId,
            resolvedSources[index]!,
        ]),
    );
    const sourceOwnerNames = new Map(sourceOwners.map((account) => [
        account.id,
        resolveAccountDisplayLabelV1(account),
    ]));
    const activeLimitCounts = new Map<string, number>();
    for (const limitRow of activeLimits) {
        activeLimitCounts.set(limitRow.resourceId, (activeLimitCounts.get(limitRow.resourceId) ?? 0) + 1);
    }
    const projections = await Promise.all(administrationRows
        .map(row => projectSummary(tx, row, audiences.get(row.id) ?? NO_AUDIENCE, input.actorAccountId, {
            isQualifiedTeamManager: qualifiedViewer.manageCredentials,
            isQualifiedTeamMember: qualification.ok && actor.capabilities.viewTeam,
        }, {
            sourceOwnerDisplayName: sourceOwnerNames.get(row.custodianAccountId) ?? null,
            activeUsageLimitCount: activeLimitCounts.get(row.id) ?? 0,
            brokerPresentation: brokerPresentations.get(row.custodianAccountId),
            sourceResolution: sourceResolutionByResourceId.get(row.id) ?? null,
        })));
    const resources = projections
        .filter((projection): projection is Extract<typeof projection, { ok: true }> => projection.ok)
        .map(projection => projection.resource);
    const lastRow = lastProcessedCandidate;
    const resourceById = new Map(resources.map(resource => [resource.id, resource]));
    const readinessResources = administrationRows.flatMap(row => {
        const visible = resourceById.get(row.id);
        if (!visible) return [];
        const source = parsedSources.get(row.id) ?? null;
        const brokerPresentation = brokerPresentations.get(row.custodianAccountId)
            ?? { eligibleTargets: [], eligiblePools: [] };
        return [TeamCredentialResourceSummaryV1Schema.parse({
            ...visible,
            source,
            brokerPlacement: (() => {
                const read = readTeamCredentialBrokerPlacement(row);
                return read.ok ? read.placement : null;
            })(),
            brokerPresentation: {
                selectedTarget: brokerPresentation.eligibleTargets.find(target => target.machineId === row.brokerMachineId) ?? null,
                eligibleTargets: brokerPresentation.eligibleTargets,
                selectedPool: brokerPresentation.eligiblePools.find(pool => pool.poolId === row.brokerPoolId) ?? null,
                eligiblePools: brokerPresentation.eligiblePools,
            },
        })];
    });
    return { ok: true as const, readinessResources, page: {
        resources,
        nextCursor: hasMore && lastRow ? encodeTeamCredentialResourcesCursorV1({
            queryKey, displayName: lastRow.displayName, id: lastRow.id,
        }) : null,
        viewer: {
            manageCredentials: qualifiedViewer.manageCredentials,
            offerOwnCredential: qualifiedViewer.offerOwnCredential,
        },
    } };
}

export async function readTeamCredentialResourceAdministrationInTx(tx: Tx, input: Readonly<{
    resourceId: string;
    actorAccountId: string;
    authentication: TeamOperationAuthenticationContext;
}>) {
    const row = await tx.teamCredentialResource.findUnique({ where: { id: input.resourceId } });
    if (!row) return { ok: false as const, error: "not_found_or_not_visible" as const };
    const account = await tx.account.findUnique({
        where: { id: input.actorAccountId },
        select: { status: true },
    });
    if (account?.status !== "active") return { ok: false as const, error: "not_found_or_not_visible" as const };
    const actor = await resolveTeamActorContextInTx(tx, {
        teamId: row.teamId,
        actorAccountId: input.actorAccountId,
    });
    if (!actor?.capabilities.viewTeam) {
        return { ok: false as const, error: "not_found_or_not_visible" as const };
    }
    const viewer = resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt });
    const isSourceCustodian = row.custodianAccountId === input.actorAccountId;
    if (!viewer.manageCredentials && !isSourceCustodian) {
        return { ok: false as const, error: "not_found_or_not_visible" as const };
    }
    const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, input.authentication);
    if (!qualification.ok) return qualification;
    const audience = (await readAudiencesInTx(tx, [row.id])).get(row.id) ?? NO_AUDIENCE;
    const projected = await projectSummary(tx, row, audience, input.actorAccountId, {
        isQualifiedTeamManager: viewer.manageCredentials,
        isQualifiedTeamMember: true,
    });
    return projected.ok ? projected : { ok: false as const, error: "resource_corrupt" as const };
}

/**
 * Lists only resources whose stored, canonical source binding has the exact
 * stable logical identity selected on the authenticated Account's source-detail
 * surface.
 *
 * `custodianAccountId` is always constrained before stored JSON is inspected.
 * The locator is therefore only a selector within the caller's own rows, never
 * a claim that the caller owns an Account, Pool, or Provider connection. Source
 * revision fields are intentionally excluded so stale/replaced sources remain
 * withdrawable.
 */
export async function readTeamCredentialSourceResourceAdministrationInTx(tx: Tx, input: Readonly<{
    actorAccountId: string;
    source: TeamCredentialSourceLocatorV1;
    authentication: TeamOperationAuthenticationContext;
    cursor?: string;
    limit?: number;
}>) {
    const account = await tx.account.findUnique({
        where: { id: input.actorAccountId },
        select: { status: true },
    });
    if (account?.status !== "active") {
        return { ok: false as const, error: "not_found_or_not_visible" as const };
    }
    const locatorKey = teamCredentialSourceLocatorKeyV1(input.source);
    const limit = input.limit ?? 50;
    const queryKey = `v1:credential-source-resources:${input.actorAccountId}:${locatorKey}`;
    const decoded = input.cursor ? decodeTeamCredentialResourcesCursorV1(input.cursor, queryKey) : null;
    if (decoded?.status === 'invalid') return { ok: false as const, error: 'invalid_resource_input' as const };
    const after = decoded?.status === 'ok' ? decoded.cursor : null;
    const sourceIdentityNeedle = input.source.kind === 'provider_connection'
        ? `\"connectionId\":${JSON.stringify(input.source.connectionId)}`
        : input.source.kind === 'connected_pool'
            ? `\"groupId\":${JSON.stringify(input.source.target.groupId)}`
            : `\"accountId\":${JSON.stringify(input.source.target.account.accountId)}`;
    const matchesSource = (row: ResourceRow) => {
        const source = readTeamCredentialSourceBinding(row.sourceBindingJson);
        return source.success
            && teamCredentialSourceLocatorKeyV1(teamCredentialSourceLocatorV1(source.data)) === locatorKey;
    };
    const candidateWindow = await tx.teamCredentialResource.findMany({
            where: {
                custodianAccountId: input.actorAccountId,
                sourceBindingJson: { contains: sourceIdentityNeedle },
                ...(after ? { OR: [
                    { displayName: { gt: after.displayName } },
                    { displayName: after.displayName, id: { gt: after.id } },
                ] } : {}),
            },
            orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: limit + 1,
        });
    const processedCandidates = candidateWindow.slice(0, limit);
    const pageRows = processedCandidates.filter(matchesSource);
    const lastProcessedCandidate = processedCandidates.at(-1) ?? null;
    const actorContexts = await resolveTeamActorContextsInTx(tx, {
        teamIds: pageRows.map(row => row.teamId), actorAccountId: input.actorAccountId,
    });
    const viewableActors = [...new Set(pageRows.map(row => row.teamId))].flatMap((teamId) => {
        const actor = actorContexts.get(teamId) ?? null;
        return actor?.capabilities.viewTeam ? [actor] : [];
    });
    const qualifications = await qualifyTeamCredentialOperationsInTx(tx, viewableActors, input.authentication);
    const actors = new Map([...new Set(pageRows.map(row => row.teamId))].map((teamId) => {
        const actor = actorContexts.get(teamId) ?? null;
        return [teamId, {
            actor,
            qualification: qualifications.get(teamId) ?? { ok: false as const },
        }] as const;
    }));
    const parsedSources = pageRows.map(row => {
        const parsed = readTeamCredentialSourceBinding(row.sourceBindingJson);
        return parsed.success ? parsed.data : null;
    });
    const sourceResolutions = await resolveTeamCredentialResourceSourcesInTx(tx, pageRows.map((row, index) => ({
        custodianAccountId: row.custodianAccountId, source: parsedSources[index],
    })));
    const brokerPresentations = await projectTeamCredentialBrokerPresentationsInTx(tx, [input.actorAccountId]);
    const projected = await Promise.all(pageRows.map(async (row, index) => {
        const context = actors.get(row.teamId);
        const actor = context?.actor ?? null;
        const qualification = context?.qualification ?? { ok: false as const };
        const isQualifiedTeamMember = qualification.ok && actor?.capabilities.viewTeam === true;
        const isQualifiedTeamManager = qualification.ok && actor !== null
            && resolveTeamCredentialCapabilities({ ...actor, teamArchivedAt: actor.team.archivedAt }).manageCredentials;
        const summary = await projectSummary(tx, row, NO_AUDIENCE, input.actorAccountId, {
            isQualifiedTeamManager,
            isQualifiedTeamMember,
        }, {
            brokerPresentation: brokerPresentations.get(input.actorAccountId),
            sourceResolution: sourceResolutions[index] ?? null,
        });
        if (!summary.ok) return null;
        const resource = summary.resource;
        return {
            resource: TeamCredentialSourceResourceAdministrationV1Schema.parse({
                id: resource.id,
                displayName: resource.displayName,
                enabled: resource.enabled,
                revision: resource.revision,
                disclosureCeiling: resource.disclosureCeiling,
                brokerPlacement: resource.brokerPlacement,
                brokerPresentation: resource.brokerPresentation,
                readiness: resource.readiness,
                recoveryAction: resource.recoveryAction,
                capabilities: resource.capabilities,
                createdAt: resource.createdAt,
                updatedAt: resource.updatedAt,
            }),
            readinessResource: resource,
        };
    }));
    const visible = projected.filter((row): row is NonNullable<typeof row> => row !== null);
    const resources = visible;
    return {
        ok: true as const,
        readinessResources: resources.map(row => row.readinessResource),
        page: {
            resources: resources.map(row => row.resource),
            nextCursor: candidateWindow.length > limit && lastProcessedCandidate ? encodeTeamCredentialResourcesCursorV1({
                queryKey, displayName: lastProcessedCandidate.displayName, id: lastProcessedCandidate.id,
            }) : null,
        },
    };
}
