import { createHash } from "node:crypto";
import {
    TeamCredentialBrokerPlacementV1Schema,
    type TeamCredentialBrokerPlacementV1,
} from "@happier-dev/protocol/teams";
import type { MachineIrohEndpointAuthorityV1 } from "@happier-dev/protocol";

import type { Tx } from "@/storage/inTx";
import { isServerFeatureEnabledForHome } from "@/app/features/catalog/serverFeatureGate";
import type { MachineDaemonPresenceInventory } from "@/app/machines/machineDaemonPresence";
import {
    getMachinePoolCandidateSnapshotInTx,
    type MachinePoolCandidateSnapshot,
} from "@/app/machines/pools/machinePoolService";
import { selectMachinePoolCandidate } from "@happier-dev/protocol/machines/pools";
import { acquireMachinePoolMutationFenceInTx } from "@/app/machines/pools/machinePoolMutationFence";
import {
    classifyTeamCredentialBrokerMachineEligibility,
    resolveTeamCredentialBrokerMachinePresentInTx,
    resolveTeamCredentialBrokerMachineForSaveInTx,
    type TeamCredentialBrokerMachineEligibilityError,
} from "./brokerMachineEligibility";

/** The two persisted placement columns exactly as the resource row carries them. */
export interface TeamCredentialBrokerPlacementRow {
    readonly brokerMachineId: string | null;
    readonly brokerPoolId: string | null;
}

export interface TeamCredentialBrokerPlacementResource extends TeamCredentialBrokerPlacementRow {
    readonly id: string;
    readonly custodianAccountId: string;
}

export type TeamCredentialBrokerPlacementRead =
    | Readonly<{ ok: true; placement: TeamCredentialBrokerPlacementV1 | null }>
    | Readonly<{ ok: false; error: "resource_corrupt" }>;

/**
 * The one interpretation of the persisted placement columns. Exactly one of
 * the two columns names the broker location; both set is corrupt and neither
 * set is an unplaced resource. Every placement, eligibility and selection
 * decision starts from this reader; callers never compare the raw columns.
 */
export function readTeamCredentialBrokerPlacement(row: TeamCredentialBrokerPlacementRow): TeamCredentialBrokerPlacementRead {
    if (row.brokerMachineId !== null && row.brokerPoolId !== null) return { ok: false, error: "resource_corrupt" };
    if (row.brokerMachineId === null && row.brokerPoolId === null) return { ok: true, placement: null };
    const parsed = TeamCredentialBrokerPlacementV1Schema.safeParse(row.brokerMachineId !== null
        ? { kind: "machine", machineId: row.brokerMachineId }
        : { kind: "machine_pool", poolId: row.brokerPoolId });
    return parsed.success ? { ok: true, placement: parsed.data } : { ok: false, error: "resource_corrupt" };
}

/** Opaque original resource location; revisions, policy and Pool membership are not identity. */
export function resolveTeamCredentialBrokerPlacementFingerprint(
    resource: TeamCredentialBrokerPlacementRow & Readonly<{ id: string }>,
): string | null {
    const read = readTeamCredentialBrokerPlacement(resource);
    if (!read.ok || read.placement === null) return null;
    const placement = read.placement;
    return createHash("sha256").update(JSON.stringify([
        resource.id,
        placement.kind,
        placement.kind === "machine" ? placement.machineId : placement.poolId,
    ])).digest("hex");
}

const BROKER_MACHINE_ELIGIBILITY_SELECT = {
    kind: true,
    revokedAt: true,
    replacedByMachineId: true,
    operationProtocolCapabilities: true,
    operationProtocolCapabilitiesRevision: true,
} as const;

/**
 * Saved Pool placement validates what a saved reference must be: the operator
 * still offers Pools and the Pool is the custodian's own. It deliberately does
 * not require a member that can run the source today, so an empty, offline or
 * outdated Pool stays a truthful placement its custodian can repair instead of
 * a write the editor offers and the writer refuses. Readiness for a brokered
 * open is the separate question `admitTeamCredentialBrokerPoolForBrokeredUseInTx`
 * answers.
 */
export async function resolveTeamCredentialBrokerPoolForSaveInTx(
    tx: Tx,
    input: Readonly<{ custodianAccountId: string; poolId: string }>,
): Promise<Readonly<{ ok: true; poolId: string }> | TeamCredentialBrokerMachineEligibilityError> {
    // An operator who opted this Home out of Machine Pools has no Pool broker
    // locations at all, so a credential placement cannot be saved onto one
    // either. The Pool routes already refuse; this is the same decision at the
    // one credential placement write owner.
    if (!await isServerFeatureEnabledForHome("machines.pools", { tx })) {
        return { ok: false, error: "broker_unavailable" };
    }
    const pool = await tx.machinePool.findFirst({
        where: { id: input.poolId, accountId: input.custodianAccountId },
        select: { id: true },
    });
    if (!pool) return { ok: false, error: "broker_unavailable" };
    return { ok: true, poolId: pool.id };
}

/** Validates a selected location independently from whether its audience needs brokerage. */
export async function validateTeamCredentialBrokerPlacementForSaveInTx(
    tx: Tx,
    input: Readonly<{ custodianAccountId: string; placement: TeamCredentialBrokerPlacementV1 | null }>,
): Promise<Readonly<{ ok: true }> | TeamCredentialBrokerMachineEligibilityError> {
    if (input.placement === null) return { ok: true };
    if (input.placement.kind === "machine") {
        return await resolveTeamCredentialBrokerMachineForSaveInTx(tx, {
            custodianAccountId: input.custodianAccountId,
            brokerMachineId: input.placement.machineId,
        });
    }
    // Attachment and deletion share the Pool row's transaction lock so a
    // selected reference cannot miss deletion's resource invalidation.
    const exists = await acquireMachinePoolMutationFenceInTx({
        tx, accountId: input.custodianAccountId, poolId: input.placement.poolId,
    });
    if (!exists) return { ok: false, error: "broker_unavailable" };
    return await resolveTeamCredentialBrokerPoolForSaveInTx(tx, {
        custodianAccountId: input.custodianAccountId,
        poolId: input.placement.poolId,
    });
}

/**
 * Brokered-use readiness for an already-saved Pool placement: the placement
 * must still be a Pool this Home offers and the custodian owns, and at least
 * one enabled member must currently be a compatible persistent broker. This is
 * the admission question, not the reference-validity question the save owner
 * answers, and it is the one place Pool member eligibility is classified.
 */
export async function admitTeamCredentialBrokerPoolForBrokeredUseInTx(
    tx: Tx,
    input: Readonly<{ custodianAccountId: string; poolId: string }>,
): Promise<Readonly<{ ok: true; poolId: string }> | TeamCredentialBrokerMachineEligibilityError> {
    const saved = await resolveTeamCredentialBrokerPoolForSaveInTx(tx, input);
    if (!saved.ok) return saved;
    const members = await tx.machinePoolMember.findMany({
        where: { poolId: input.poolId, enabled: true, pool: { accountId: input.custodianAccountId } },
        select: { machine: { select: BROKER_MACHINE_ELIGIBILITY_SELECT } },
    });
    const eligibilities = members.map((member) => classifyTeamCredentialBrokerMachineEligibility(member.machine));
    if (eligibilities.includes("eligible")) return { ok: true, poolId: saved.poolId };
    return { ok: false, error: eligibilities.includes("update_required") ? "update_required" : "broker_unavailable" };
}

/**
 * How much of the placement a presented broker Machine must still satisfy.
 *
 * - `per_request` (default) — the request still gets to choose its target, so a
 *   Pool placement must currently carry that Machine as an enabled member.
 * - `established` — the target was selected for this operation before and
 *   travels in its own record or signed binding. Per 11.03 §B3, tier
 *   reordering, disabling and removal affect future selections only, so Pool
 *   membership is never an ongoing ACL for an established target.
 *
 * An exact placement always names its one Machine in both modes.
 */
export type TeamCredentialBrokerPlacementSelection = "per_request" | "established";

type TeamCredentialBrokerPlacementBinding =
    | "bound"
    | "unreadable"
    | "not_placed"
    | "not_named"
    | "not_current_member";

/** The one placement decision both the boolean predicate and admission read. */
async function checkTeamCredentialBrokerPlacementBindingInTx(
    tx: Tx,
    input: Readonly<{
        resource: TeamCredentialBrokerPlacementRow & Readonly<{ custodianAccountId: string }>;
        machineId: string;
        selection: TeamCredentialBrokerPlacementSelection;
    }>,
): Promise<TeamCredentialBrokerPlacementBinding> {
    const read = readTeamCredentialBrokerPlacement(input.resource);
    if (!read.ok) return "unreadable";
    if (read.placement === null) return "not_placed";
    if (read.placement.kind === "machine") {
        return read.placement.machineId === input.machineId ? "bound" : "not_named";
    }
    if (input.selection === "established") return "bound";
    return await isCurrentTeamCredentialBrokerPoolMemberInTx(tx, {
        custodianAccountId: input.resource.custodianAccountId,
        poolId: read.placement.poolId,
        machineId: input.machineId,
    }) ? "bound" : "not_current_member";
}

/**
 * True when this Machine is the broker the resource's current placement names.
 * Existing-Session validation and fresh Runner selection ask the `per_request`
 * question; an activation rereading the exact target it already froze asks the
 * `established` one. The Machine's own eligibility stays with the Machine owner.
 */
export async function isTeamCredentialBrokerPlacementBoundToMachineInTx(
    tx: Tx,
    input: Readonly<{
        resource: TeamCredentialBrokerPlacementRow & Readonly<{ custodianAccountId: string }>;
        machineId: string;
        selection?: TeamCredentialBrokerPlacementSelection;
    }>,
): Promise<boolean> {
    return await checkTeamCredentialBrokerPlacementBindingInTx(tx, {
        resource: input.resource,
        machineId: input.machineId,
        selection: input.selection ?? "per_request",
    }) === "bound";
}

async function isCurrentTeamCredentialBrokerPoolMemberInTx(
    tx: Tx,
    input: Readonly<{ custodianAccountId: string; poolId: string; machineId: string }>,
): Promise<boolean> {
    const member = await tx.machinePoolMember.findFirst({
        where: {
            poolId: input.poolId,
            machineId: input.machineId,
            enabled: true,
            pool: { accountId: input.custodianAccountId },
        },
        select: { machineId: true },
    });
    return member !== null;
}

export type TeamCredentialBrokerMachineAdmission =
    | Readonly<{ ok: true; machineId: string }>
    | TeamCredentialBrokerMachineEligibilityError
    | Readonly<{ ok: false; error: "resource_unavailable" | "resource_changed" }>;

/**
 * Admission of one presented broker Machine against the resource's current
 * placement, in the caller's selection mode (see
 * `TeamCredentialBrokerPlacementSelection`). An external API key's requests
 * present the Machine its per-key operation was established on, so they are
 * `established`; a resource Test request is its own selection.
 *
 * Eligibility is then rechecked by the one Machine owner.
 */
export async function admitTeamCredentialBrokerMachineForResourceInTx(
    tx: Tx,
    input: Readonly<{
        resource: TeamCredentialBrokerPlacementResource;
        brokerMachineId: string;
        selection?: TeamCredentialBrokerPlacementSelection;
    }>,
): Promise<TeamCredentialBrokerMachineAdmission> {
    const binding = await checkTeamCredentialBrokerPlacementBindingInTx(tx, {
        resource: input.resource,
        machineId: input.brokerMachineId,
        selection: input.selection ?? "per_request",
    });
    if (binding === "unreadable") return { ok: false, error: "resource_unavailable" };
    if (binding === "not_placed" || binding === "not_named") return { ok: false, error: "resource_changed" };
    if (binding === "not_current_member") return { ok: false, error: "broker_unavailable" };
    const saved = await resolveTeamCredentialBrokerMachineForSaveInTx(tx, {
        custodianAccountId: input.resource.custodianAccountId,
        brokerMachineId: input.brokerMachineId,
    });
    return saved.ok ? { ok: true, machineId: saved.machineId } : saved;
}

export type TeamCredentialBrokerPlacementResolution =
    | Readonly<{
        ok: true;
        broker: Readonly<{
            machineId: string;
            /**
             * Present only when the Machine advertises its own Iroh endpoint.
             * A relay-reached broker carries none; the private-tunnel consumer
             * is the one that requires it.
             */
            endpointAuthority: MachineIrohEndpointAuthorityV1 | null;
        }> | null;
        poolSnapshot: MachinePoolCandidateSnapshot | null;
        candidateMachineIds: readonly string[];
    }>
    | TeamCredentialBrokerMachineEligibilityError
    | Readonly<{ ok: false; error: "resource_unavailable" | "resource_changed" }>;

/**
 * Canonical exact-placement resolver for a new credential-broker open.
 * Pool selection ends here: consumers receive one exact Machine, while the
 * Pool snapshot and source-eligible set remain server-private.
 *
 * A pinned Machine belongs to an already-established open and deliberately
 * bypasses current Pool membership ranking. Pool edits affect future opens;
 * current resource, source and exact-Machine authority remain independently
 * revalidated by the broker admission owner.
 */
export async function resolveTeamCredentialBrokerPlacementInTx(
    tx: Tx,
    input: Readonly<{
        resource: TeamCredentialBrokerPlacementResource;
        presence: MachineDaemonPresenceInventory;
        requestKey: string;
        pinnedMachineId?: string | null;
        poolEligibleMachineIds?: ReadonlySet<string>;
        expectedPoolMachineId?: string;
    }>,
): Promise<TeamCredentialBrokerPlacementResolution> {
    const read = readTeamCredentialBrokerPlacement(input.resource);
    if (!read.ok) return { ok: false, error: "resource_unavailable" };
    const placement = read.placement;
    if (placement === null) return { ok: false, error: "broker_unavailable" };

    const pinnedMachineId = input.pinnedMachineId ?? null;
    let selectedMachineId: string | null = pinnedMachineId;
    let poolSnapshot: MachinePoolCandidateSnapshot | null = null;
    let candidateMachineIds: readonly string[] = [];

    if (placement.kind === "machine") {
        if (pinnedMachineId !== null && placement.machineId !== pinnedMachineId) {
            return { ok: false, error: "resource_changed" };
        }
        selectedMachineId = placement.machineId;
    } else if (pinnedMachineId === null) {
        const snapshot = await getMachinePoolCandidateSnapshotInTx(tx, {
            accountId: input.resource.custodianAccountId,
            poolId: placement.poolId,
            presence: input.presence,
        });
        if (!snapshot.ok || snapshot.value.presenceState !== "known") {
            return { ok: false, error: "broker_unavailable" };
        }
        poolSnapshot = snapshot.value;
        candidateMachineIds = snapshot.value.members.flatMap((member) => (
            member.enabled && snapshot.value.availableMachineIds.has(member.machineId)
                ? [member.machineId]
                : []
        ));
        if (input.poolEligibleMachineIds === undefined) {
            return { ok: true, broker: null, poolSnapshot, candidateMachineIds };
        }
        const availableMachineIds = new Set(candidateMachineIds.filter((machineId) => (
            input.poolEligibleMachineIds!.has(machineId)
        )));
        selectedMachineId = selectMachinePoolCandidate({
            purpose: "session",
            members: snapshot.value.members,
            availableMachineIds,
            requestKey: input.requestKey,
        })?.machineId ?? null;
        if (selectedMachineId === null) return { ok: false, error: "broker_unavailable" };
        if (input.expectedPoolMachineId !== undefined && selectedMachineId !== input.expectedPoolMachineId) {
            return { ok: false, error: "broker_unavailable" };
        }
    }

    if (selectedMachineId === null) return { ok: false, error: "broker_unavailable" };
    const broker = await resolveTeamCredentialBrokerMachinePresentInTx(tx, {
        custodianAccountId: input.resource.custodianAccountId,
        brokerMachineId: selectedMachineId,
        presence: input.presence,
    });
    if (!broker.ok) return broker;
    return {
        ok: true,
        broker: {
            machineId: broker.machineId,
            endpointAuthority: broker.endpointAuthority,
        },
        poolSnapshot,
        candidateMachineIds,
    };
}
