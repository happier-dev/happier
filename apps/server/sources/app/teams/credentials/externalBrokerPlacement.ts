import { randomUUID } from "node:crypto";
import { type TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import { readTeamCredentialSourceBinding } from './sourceBindingRead';

import type { MachineDaemonPresenceInventory } from "@/app/machines/machineDaemonPresence";
import { inTx, type Tx } from "@/storage/inTx";
import { verifyTeamCredentialExternalApiKeyInTx, type VerifyTeamCredentialExternalApiKeyResult } from "./externalApiKey";
import {
    resolveTeamCredentialBrokerPlacementInTx,
    readTeamCredentialBrokerPresenceDemand,
    resolveTeamCredentialBrokerPlacementFingerprint,
    selectTeamCredentialBrokerPoolMachine,
    type TeamCredentialBrokerPlacementResource,
} from "./brokerPlacementResolver";
import { resolveTeamCredentialResourceSourceInTx, type TeamCredentialResourceSourceResolution } from "./resourceSourceResolver";
import { readExternalBrokerOperation, readExternalBrokerOperationKeyInTx, type ExternalBrokerOperation } from "./externalBrokerOperation";

/** The external-key question put to the canonical Pool source-eligibility reader. */
export type ExternalBrokerPoolSourceEligibilityReader = (input: Readonly<{
    custodianAccountId: string;
    machineIds: readonly string[];
    teamId: string;
    resourceId: string;
    resourceRevision: number;
    source: TeamCredentialSourceBindingV1;
    signal: AbortSignal;
}>) => Promise<Readonly<{ eligibleMachineIds: ReadonlySet<string> }>>;

type CurrentKeyAuthority = Extract<VerifyTeamCredentialExternalApiKeyResult, { ok: true }>;
type ExternalBrokerOpen = Readonly<{
    ok: true;
    authority: CurrentKeyAuthority;
    source: TeamCredentialSourceBindingV1 | null;
    sourceResolution: TeamCredentialResourceSourceResolution | null;
}> | Extract<VerifyTeamCredentialExternalApiKeyResult, { ok: false }>;

export type ExternalBrokerPlacementResult =
    | Readonly<{ ok: true; custodianAccountId: string; brokerMachineId: string; operationId: string | null; brokerPlacementFingerprint: string }>
    | Readonly<{ ok: false; error: "broker_unavailable" | "resource_unavailable" | 'connected_service_credential_reconnect_required' }>;

function unchangedAuthority(left: CurrentKeyAuthority, right: NonNullable<Awaited<ReturnType<typeof readExternalBrokerOperationKeyInTx>>>): boolean {
    return left.resourceId === right.resourceId
        && left.teamId === right.teamId
        && left.assignedAccountId === right.assignedAccountId
        && left.assignedTeamMembershipId === right.assignedTeamMembershipId
        && left.custodianAccountId === right.custodianAccountId
        && left.brokerMachineId === right.brokerMachineId
        && left.brokerPoolId === right.brokerPoolId
        && left.resourceRevision === right.resourceRevision
        && left.sourceBindingJson === right.sourceBindingJson;
}

/** Admit the caller and read the initial source in the same transaction. */
export async function readTeamCredentialExternalBrokerOpenInTx(
    tx: Tx,
    token: string,
): Promise<ExternalBrokerOpen> {
    const authority = await verifyTeamCredentialExternalApiKeyInTx(tx, { token });
    if (!authority.ok) return authority;
    const source = readTeamCredentialSourceBinding(authority.sourceBindingJson);
    if (!source.success) return { ok: true, authority, source: null, sourceResolution: null };
    const sourceResolution = await resolveTeamCredentialResourceSourceInTx(tx, {
        custodianAccountId: authority.custodianAccountId,
        source: source.data,
    });
    return { ok: true, authority, source: source.data, sourceResolution };
}

function placementResource(authority: Pick<CurrentKeyAuthority, 'resourceId' | 'custodianAccountId' | 'brokerMachineId' | 'brokerPoolId'>): TeamCredentialBrokerPlacementResource {
    return {
        id: authority.resourceId,
        custodianAccountId: authority.custodianAccountId,
        brokerMachineId: authority.brokerMachineId,
        brokerPoolId: authority.brokerPoolId,
    };
}

/**
 * Resolves one external request to the exact broker Machine of its key's
 * operation through the one placement owner.
 *
 * - Exact placement: that Machine, revalidated for eligibility and presence.
 * - Pool placement with an established operation: the Machine it was
 *   established on, while that Machine is present, an eligible custodian
 *   broker and can still run the source. Tier reordering, disabling and
 *   removing members affect future opens only (L11/03:147 step 7), so the
 *   current member list is never reranked for it.
 * - With no current operation: the Pool is ranked under the key's stable
 *   request key and the chosen member rechecked before dispatch; a member that
 *   changes between ranking and the recheck fails this open rather than
 *   rotating (L10/05:194, B11-05).
 *
 * The existing key atomically retains the exact target before dispatch.
 * Catalog reads never establish custody; a racing inference invalidates their
 * null-operation authorization at the ordinary admission boundary.
 */
export async function resolveTeamCredentialExternalBrokerPlacement(input: Readonly<{
    open: Extract<ExternalBrokerOpen, { ok: true }>;
    catalogOnly?: boolean;
    signal: AbortSignal;
    readCurrentPresence: (custodianAccountId: string, machineIds?: readonly string[]) => Promise<MachineDaemonPresenceInventory>;
    readPoolSourceEligibility: ExternalBrokerPoolSourceEligibilityReader;
}>): Promise<ExternalBrokerPlacementResult> {
    const { authority, source, sourceResolution } = input.open;
    if (!source || sourceResolution?.status !== "current") return { ok: false, error: "resource_unavailable" };
    if (sourceResolution.authenticationFailure) return { ok: false, error: sourceResolution.authenticationFailure };
    if (input.signal.aborted) return { ok: false, error: "broker_unavailable" };
    const resource = placementResource(authority);
    const fingerprint = resolveTeamCredentialBrokerPlacementFingerprint(resource);
    if (fingerprint === null) return { ok: false, error: "resource_unavailable" };
    const sourceBindingJson = JSON.stringify(source);
    const operationMatches = (operation: ExternalBrokerOperation) =>
        operation.brokerPlacementFingerprint === fingerprint && operation.sourceBindingJson === sourceBindingJson;
    const established = authority.currentBrokerOperationJson === null
        ? null : readExternalBrokerOperation(authority.currentBrokerOperationJson);
    if (authority.currentBrokerOperationJson !== null && (!established || !operationMatches(established))) {
        return { ok: false, error: "resource_unavailable" };
    }

    let initialPresence: MachineDaemonPresenceInventory;
    try {
        const machineIds = await readTeamCredentialBrokerPresenceDemand({
            resource, pinnedMachineId: established?.brokerMachineId,
        });
        initialPresence = await input.readCurrentPresence(authority.custodianAccountId, machineIds);
    } catch {
        return { ok: false, error: "broker_unavailable" };
    }
    const requestKey = [
        authority.resourceId,
        "external_api_key",
        authority.keyId,
    ].join("\u0000");
    const readEligibility = async (machineIds: readonly string[]) => {
        try {
            const eligibility = await input.readPoolSourceEligibility({
                custodianAccountId: authority.custodianAccountId,
                machineIds,
                teamId: authority.teamId,
                resourceId: authority.resourceId,
                resourceRevision: authority.resourceRevision,
                source,
                signal: input.signal,
            });
            return input.signal.aborted ? null : eligibility.eligibleMachineIds;
        } catch {
            return null;
        }
    };
    /** Seals the selected target against the current key and placement rows. */
    const confirm = async (
        target: Readonly<{ pinnedMachineId: string } | { poolEligibleMachineIds: ReadonlySet<string>; expectedPoolMachineId: string }>,
        probedMachineIds: readonly string[],
        eligibleMachineIds: ReadonlySet<string>,
    ): Promise<ExternalBrokerPlacementResult> => {
        const candidateMachineId = "pinnedMachineId" in target ? target.pinnedMachineId : target.expectedPoolMachineId;
        if (input.signal.aborted) return { ok: false, error: "broker_unavailable" };
        let currentPresence: MachineDaemonPresenceInventory;
        try {
            // An unestablished Pool operation can acquire another request's concurrent
            // winner, even after that Machine leaves the Pool. Its target is not yet
            // known here; retain the complete census for that existing adoption path.
            currentPresence = await input.readCurrentPresence(authority.custodianAccountId,
                established || authority.brokerMachineId !== null ? [candidateMachineId] : undefined);
        } catch {
            return { ok: false, error: "broker_unavailable" };
        }
        const current = await inTx(async (tx): Promise<ExternalBrokerOperation
            | Readonly<{ brokerMachineId: string; operationId: null }>
            | null> => {
            const reread = await readExternalBrokerOperationKeyInTx(tx, authority.keyId);
            if (!reread || !unchangedAuthority(authority, reread)) return null;
            const retained = reread.currentBrokerOperationJson === null
                ? null : readExternalBrokerOperation(reread.currentBrokerOperationJson);
            if (reread.currentBrokerOperationJson !== null && (!retained || !operationMatches(retained))) return null;
            // A retired initial operation cannot be resurrected by this in-flight request.
            if (established && retained?.operationId !== established.operationId) return null;
            const placement = await resolveTeamCredentialBrokerPlacementInTx(tx, {
                resource,
                presence: currentPresence,
                requestKey,
                ...(retained ? { pinnedMachineId: retained.brokerMachineId } : target),
            });
            if (!placement.ok || !placement.broker) return null;
            if (retained) return retained;
            if (input.catalogOnly) return { brokerMachineId: placement.broker.machineId, operationId: null };
            const operation: ExternalBrokerOperation = {
                v: 1, operationId: randomUUID(), brokerMachineId: placement.broker.machineId,
                brokerPlacementFingerprint: fingerprint, sourceBindingJson,
            };
            const claimed = await tx.teamCredentialExternalApiKey.updateMany({
                where: { id: authority.keyId, currentBrokerOperationJson: null },
                data: { currentBrokerOperationJson: JSON.stringify(operation) },
            });
            if (claimed.count === 1) return operation;
            const winner = await tx.teamCredentialExternalApiKey.findUnique({
                where: { id: authority.keyId }, select: { currentBrokerOperationJson: true },
            });
            const winningOperation = winner?.currentBrokerOperationJson
                ? readExternalBrokerOperation(winner.currentBrokerOperationJson) : null;
            return winningOperation && operationMatches(winningOperation) ? winningOperation : null;
        }, { isolationLevel: "Serializable" /* Seal the key, resource and exact Machine against concurrent opens. */ });
        if (!current) return { ok: false, error: "broker_unavailable" };
        // A concurrent winner may differ from the candidate this request probed.
        // Validate that exact winner; never dispatch the losing candidate.
        if (probedMachineIds.includes(current.brokerMachineId)) {
            if (!eligibleMachineIds.has(current.brokerMachineId)) return { ok: false, error: "broker_unavailable" };
        } else {
            const eligible = await readEligibility([current.brokerMachineId]);
            if (!eligible?.has(current.brokerMachineId)) return { ok: false, error: "broker_unavailable" };
        }
        return {
            ok: true, custodianAccountId: authority.custodianAccountId,
            brokerMachineId: current.brokerMachineId, operationId: current.operationId,
            brokerPlacementFingerprint: fingerprint,
        };
    };

    const candidates = await inTx((tx) => resolveTeamCredentialBrokerPlacementInTx(tx, {
        resource,
        presence: initialPresence,
        requestKey,
        ...(established ? { pinnedMachineId: established.brokerMachineId } : {}),
    }));
    if (!candidates.ok) {
        return { ok: false, error: !established && candidates.error === "resource_unavailable"
            ? "resource_unavailable" : "broker_unavailable" };
    }
    // The retained Machine is the only candidate until its operation owner
    // retires it. An eligibility refusal never opens the same key elsewhere.
    if (candidates.broker !== null) {
        const machineId = candidates.broker.machineId;
        const eligible = await readEligibility([machineId]);
        if (!eligible?.has(machineId)) return { ok: false, error: "broker_unavailable" };
        return await confirm({ pinnedMachineId: machineId }, [machineId], eligible);
    }
    if (candidates.poolSnapshot === null || candidates.candidateMachineIds.length === 0) {
        return { ok: false, error: "broker_unavailable" };
    }
    const eligibleMachineIds = await readEligibility(candidates.candidateMachineIds);
    if (eligibleMachineIds === null) return { ok: false, error: "broker_unavailable" };
    const selectedMachineId = selectTeamCredentialBrokerPoolMachine({
        snapshot: candidates.poolSnapshot,
        candidateMachineIds: candidates.candidateMachineIds,
        sourceEligibleMachineIds: eligibleMachineIds,
        requestKey,
    });
    if (selectedMachineId === null) return { ok: false, error: "broker_unavailable" };
    return await confirm({
        poolEligibleMachineIds: eligibleMachineIds,
        expectedPoolMachineId: selectedMachineId,
    }, candidates.candidateMachineIds, eligibleMachineIds);
}
