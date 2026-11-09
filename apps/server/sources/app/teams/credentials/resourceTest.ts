import { type TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import { readTeamCredentialSourceBinding } from './sourceBindingRead';
import { resolveTeamCredentialResourceSourceInTx } from './resourceSourceResolver';

import type { MachineDaemonPresenceInventory } from "@/app/machines/machineDaemonPresence";
import type { Tx } from "@/storage/inTx";
import type { TeamOperationAuthenticationContext } from "../actorContext";
import { qualifyTeamOperationAuthenticationInTx, resolveTeamActorContextInTx } from "../actorContext";
import { resolveTeamCredentialCapabilities } from "../capabilities";
import { readTeamCredentialBrokerPlacement, resolveTeamCredentialBrokerPlacementInTx } from "./brokerPlacementResolver";

type TeamCredentialResourceTestAuthorization = Readonly<{
    teamId: string;
    resourceId: string;
    custodianAccountId: string;
    expectedResourceRevision: number;
    sourceBindingJson: string;
    source: TeamCredentialSourceBindingV1;
    brokerMachineId: string | null;
    brokerPoolId: string | null;
    verifiedCredentialEvidence: TeamOperationAuthenticationContext["authenticationEvidence"];
}>;

/** One authority decision shared by route, relay minting, and Home admission. */
export async function authorizeTeamCredentialResourceTestActorInTx(
    tx: Tx,
    input: Readonly<{
        teamId: string;
        custodianAccountId: string;
        actorAccountId: string;
        authentication: TeamOperationAuthenticationContext;
    }>,
): Promise<
    | Readonly<{
        ok: true;
        authority: "source_owner" | "team_manager";
        verifiedCredentialEvidence: TeamOperationAuthenticationContext["authenticationEvidence"];
    }>
    | Readonly<{
        ok: false;
        error: "not_found_or_not_visible" | "team_authentication_required" | "team_authentication_policy_unavailable";
    }>
> {
    if (input.custodianAccountId === input.actorAccountId) {
        return { ok: true, authority: "source_owner", verifiedCredentialEvidence: undefined };
    }
    const actor = await resolveTeamActorContextInTx(tx, {
        teamId: input.teamId,
        actorAccountId: input.actorAccountId,
    });
    if (!actor || !resolveTeamCredentialCapabilities({
        ...actor,
        teamArchivedAt: actor.team.archivedAt,
    }).manageCredentials) {
        return { ok: false, error: "not_found_or_not_visible" };
    }
    const qualification = await qualifyTeamOperationAuthenticationInTx(tx, {
        context: actor,
        ...input.authentication,
    });
    if (!qualification.ok) return {
        ok: false,
        error: qualification.error === "team_authentication_required"
            ? "team_authentication_required"
            : "team_authentication_policy_unavailable",
    };
    return {
        ok: true,
        authority: "team_manager",
        verifiedCredentialEvidence: input.authentication.authenticationEvidence,
    };
}

/**
 * Authorizes the saved-resource test and pins its durable source and placement
 * before the route may inspect the source custodian's live Machine presence.
 */
export async function authorizeTeamCredentialResourceTestInTx(
    tx: Tx,
    input: Readonly<{
        actorAccountId: string;
        teamId: string;
        resourceId: string;
        authentication: TeamOperationAuthenticationContext;
    }>,
) {
    const resource = await tx.teamCredentialResource.findUnique({
        where: { id: input.resourceId },
        select: {
            id: true,
            teamId: true,
            custodianAccountId: true,
            enabled: true,
            revision: true,
            sourceBindingJson: true,
            brokerMachineId: true,
            brokerPoolId: true,
        },
    });
    if (!resource || resource.teamId !== input.teamId) {
        return { ok: false as const, error: "not_found_or_not_visible" as const };
    }
    const actorAuthorization = await authorizeTeamCredentialResourceTestActorInTx(tx, {
        teamId: resource.teamId,
        actorAccountId: input.actorAccountId,
        custodianAccountId: resource.custodianAccountId,
        authentication: input.authentication,
    });
    if (!actorAuthorization.ok) return actorAuthorization;
    if (!resource.enabled) {
        return { ok: false as const, error: "resource_forbidden" as const };
    }
    const source = readTeamCredentialSourceBinding(resource.sourceBindingJson);
    if (!source.success) return { ok: false as const, error: "resource_corrupt" as const };
    const currentSource = await resolveTeamCredentialResourceSourceInTx(tx, {
        custodianAccountId: resource.custodianAccountId, source: source.data,
    });
    const authenticationFailure = currentSource.status === 'current' ? currentSource.authenticationFailure : undefined;
    const placement = readTeamCredentialBrokerPlacement(resource);
    if (!placement.ok || placement.placement === null) {
        return { ok: false as const, error: "resource_corrupt" as const };
    }
    return {
        ok: true as const,
        authenticationFailure,
        authorization: {
            teamId: resource.teamId,
            resourceId: resource.id,
            custodianAccountId: resource.custodianAccountId,
            expectedResourceRevision: resource.revision,
            sourceBindingJson: resource.sourceBindingJson,
            source: source.data,
            brokerMachineId: resource.brokerMachineId,
            brokerPoolId: resource.brokerPoolId,
            verifiedCredentialEvidence: actorAuthorization.verifiedCredentialEvidence,
        } satisfies TeamCredentialResourceTestAuthorization,
    };
}

/** One deterministic Pool ranking key per actor and resource, shared by every phase of one test. */
function resourceTestRequestKey(authorization: TeamCredentialResourceTestAuthorization, actorAccountId: string): string {
    return `resource-test\u0000${authorization.resourceId}\u0000${actorAccountId}`;
}

async function isAuthorizedResourceTestSnapshotCurrentInTx(
    tx: Tx,
    authorization: TeamCredentialResourceTestAuthorization,
): Promise<boolean> {
    const current = await tx.teamCredentialResource.findUnique({
        where: { id: authorization.resourceId },
        select: {
            teamId: true,
            custodianAccountId: true,
            revision: true,
            sourceBindingJson: true,
            brokerMachineId: true,
            brokerPoolId: true,
        },
    });
    return current !== null
        && current.teamId === authorization.teamId
        && current.custodianAccountId === authorization.custodianAccountId
        && current.revision === authorization.expectedResourceRevision
        && current.sourceBindingJson === authorization.sourceBindingJson
        && current.brokerMachineId === authorization.brokerMachineId
        && current.brokerPoolId === authorization.brokerPoolId;
}

/**
 * Rechecks the authorized durable snapshot after live presence is captured,
 * then resolves the candidate Machines through the one placement owner: the
 * exact eligible Machine, or every enabled and present Pool member.
 */
export async function resolveAuthorizedTeamCredentialResourceTestPlacementInTx(
    tx: Tx,
    input: Readonly<{
        authorization: TeamCredentialResourceTestAuthorization;
        actorAccountId: string;
        brokerPresence: MachineDaemonPresenceInventory;
    }>,
) {
    const { authorization } = input;
    if (!await isAuthorizedResourceTestSnapshotCurrentInTx(tx, authorization)) {
        return { ok: false as const, error: "resource_changed" as const };
    }
    const placement = await resolveTeamCredentialBrokerPlacementInTx(tx, {
        resource: {
            id: authorization.resourceId,
            custodianAccountId: authorization.custodianAccountId,
            brokerMachineId: authorization.brokerMachineId,
            brokerPoolId: authorization.brokerPoolId,
        },
        presence: input.brokerPresence,
        requestKey: resourceTestRequestKey(authorization, input.actorAccountId),
    });
    if (!placement.ok) {
        return placement.error === "resource_unavailable"
            ? { ok: false as const, error: "resource_corrupt" as const }
            : { ok: false as const, error: placement.error };
    }
    const candidateMachineIds = placement.broker ? [placement.broker.machineId] : placement.candidateMachineIds;
    if (candidateMachineIds.length === 0) return { ok: false as const, error: "broker_unavailable" as const };
    return {
        ok: true as const,
        snapshot: {
            teamId: authorization.teamId,
            resourceId: authorization.resourceId,
            custodianAccountId: authorization.custodianAccountId,
            expectedResourceRevision: authorization.expectedResourceRevision,
            source: authorization.source,
            brokerPoolId: authorization.brokerPoolId,
            candidateMachineIds,
        },
    };
}

/**
 * Selects the one Pool member for the test from the candidates that proved
 * source-eligible, after rechecking the authorized snapshot against current
 * presence. Exact placements never reach this phase.
 */
export async function selectAuthorizedTeamCredentialResourceTestBrokerInTx(
    tx: Tx,
    input: Readonly<{
        authorization: TeamCredentialResourceTestAuthorization;
        actorAccountId: string;
        brokerPresence: MachineDaemonPresenceInventory;
        eligibleMachineIds: ReadonlySet<string>;
    }>,
): Promise<Readonly<{ ok: true; brokerMachineId: string }> | Readonly<{ ok: false; error: "resource_changed" | "broker_unavailable" | "update_required" }>> {
    const { authorization } = input;
    if (!await isAuthorizedResourceTestSnapshotCurrentInTx(tx, authorization)) return { ok: false, error: "resource_changed" };
    const placement = await resolveTeamCredentialBrokerPlacementInTx(tx, {
        resource: {
            id: authorization.resourceId,
            custodianAccountId: authorization.custodianAccountId,
            brokerMachineId: authorization.brokerMachineId,
            brokerPoolId: authorization.brokerPoolId,
        },
        presence: input.brokerPresence,
        requestKey: resourceTestRequestKey(authorization, input.actorAccountId),
        poolEligibleMachineIds: input.eligibleMachineIds,
    });
    if (!placement.ok) {
        return { ok: false, error: placement.error === "resource_unavailable" ? "resource_changed" : placement.error };
    }
    return placement.broker ? { ok: true, brokerMachineId: placement.broker.machineId } : { ok: false, error: "broker_unavailable" };
}
