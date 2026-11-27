import { randomUUID } from "node:crypto";
import { type TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import { readTeamCredentialSourceBinding } from './sourceBindingRead';

import type { MachineDaemonPresenceInventory } from "@/app/machines/machineDaemonPresence";
import { inTx, type Tx } from "@/storage/inTx";
import { resolveCurrentTeamCredentialExternalApiKeyAuthorityInTx } from "./externalApiKey";
import {
    resolveTeamCredentialBrokerPlacementInTx,
    readTeamCredentialBrokerPresenceDemand,
    resolveTeamCredentialBrokerPlacementFingerprint,
    selectTeamCredentialBrokerPoolMachine,
    type TeamCredentialBrokerPlacementResource,
} from "./brokerPlacementResolver";
import { resolveTeamCredentialResourceSourceInTx, type TeamCredentialResourceSourceResolution } from "./resourceSourceResolver";
import { readExternalBrokerOperation, type ExternalBrokerOperation } from "./externalBrokerOperation";

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

type CurrentKeyAuthority = Extract<
    Awaited<ReturnType<typeof resolveCurrentTeamCredentialExternalApiKeyAuthorityInTx>>,
    { ok: true }
>;

type CurrentKeyAuthorityAndSource = Readonly<{
    authority: CurrentKeyAuthority;
    source: TeamCredentialSourceBindingV1;
    authenticationFailure?: Extract<TeamCredentialResourceSourceResolution, { status: 'current' }>['authenticationFailure'];
}>;

export type ExternalBrokerPlacementResult =
    | Readonly<{ ok: true; custodianAccountId: string; brokerMachineId: string; operationId: string | null; brokerPlacementFingerprint: string }>
    | Readonly<{ ok: false; error: "broker_unavailable" | "resource_unavailable" | 'connected_service_credential_reconnect_required' }>;

function unchangedAuthority(left: CurrentKeyAuthority, right: CurrentKeyAuthority): boolean {
    return left.keyId === right.keyId
        && left.resourceId === right.resourceId
        && left.teamId === right.teamId
        && left.custodianAccountId === right.custodianAccountId
        && left.brokerMachineId === right.brokerMachineId
        && left.brokerPoolId === right.brokerPoolId
        && left.resourceRevision === right.resourceRevision
        && left.sourceBindingJson === right.sourceBindingJson;
}

async function readCurrentAuthorityAndSourceInTx(
    tx: Tx,
    keyId: string,
    observedAt: Date,
): Promise<CurrentKeyAuthorityAndSource | null> {
    const authority = await resolveCurrentTeamCredentialExternalApiKeyAuthorityInTx(
        tx,
        { kind: "admitted_key", keyId },
        observedAt,
    );
    if (!authority.ok) return null;
    const source = readTeamCredentialSourceBinding(authority.sourceBindingJson);
    if (!source.success) return null;
    const current = await resolveTeamCredentialResourceSourceInTx(tx, {
        custodianAccountId: authority.custodianAccountId,
        source: source.data,
    });
    return current.status === "current" ? { authority, source: source.data,
        ...(current.authenticationFailure ? { authenticationFailure: current.authenticationFailure } : {}) } : null;
}

function placementResource(authority: CurrentKeyAuthority): TeamCredentialBrokerPlacementResource {
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
    externalApiKeyId: string;
    observedAt: Date;
    catalogOnly?: boolean;
    signal: AbortSignal;
    readCurrentPresence: (custodianAccountId: string, machineIds?: readonly string[]) => Promise<MachineDaemonPresenceInventory>;
    readPoolSourceEligibility: ExternalBrokerPoolSourceEligibilityReader;
}>): Promise<ExternalBrokerPlacementResult> {
    const initial = await inTx(async (tx) => {
        const current = await readCurrentAuthorityAndSourceInTx(tx, input.externalApiKeyId, input.observedAt);
        return current;
    });
    if (!initial) return { ok: false, error: "resource_unavailable" };
    if (initial.authenticationFailure) return { ok: false, error: initial.authenticationFailure };
    if (input.signal.aborted) return { ok: false, error: "broker_unavailable" };
    const { authority } = initial;
    const resource = placementResource(authority);
    const fingerprint = resolveTeamCredentialBrokerPlacementFingerprint(resource);
    if (fingerprint === null) return { ok: false, error: "resource_unavailable" };
    const sourceBindingJson = JSON.stringify(initial.source);
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
        input.externalApiKeyId,
    ].join("\u0000");
    const readEligibility = async (machineIds: readonly string[]) => {
        try {
            const eligibility = await input.readPoolSourceEligibility({
                custodianAccountId: authority.custodianAccountId,
                machineIds,
                teamId: authority.teamId,
                resourceId: authority.resourceId,
                resourceRevision: authority.resourceRevision,
                source: initial.source,
                signal: input.signal,
            });
            return input.signal.aborted ? null : eligibility.eligibleMachineIds;
        } catch {
            return null;
        }
    };
    /** Rereads key authority and presence and revalidates the one target immediately before dispatch. */
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
            | Readonly<{ authenticationFailure: NonNullable<CurrentKeyAuthorityAndSource['authenticationFailure']> }>
            | null> => {
            const reread = await readCurrentAuthorityAndSourceInTx(tx, input.externalApiKeyId, new Date());
            if (!reread || !unchangedAuthority(authority, reread.authority)) return null;
            if (reread.authenticationFailure) return { authenticationFailure: reread.authenticationFailure };
            const retained = reread.authority.currentBrokerOperationJson === null
                ? null : readExternalBrokerOperation(reread.authority.currentBrokerOperationJson);
            if (reread.authority.currentBrokerOperationJson !== null && (!retained || !operationMatches(retained))) return null;
            // A retired initial operation cannot be resurrected by this in-flight request.
            if (established && retained?.operationId !== established.operationId) return null;
            const placement = await resolveTeamCredentialBrokerPlacementInTx(tx, {
                resource: placementResource(reread.authority),
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
        }, { isolationLevel: "Serializable" /* External broker signing composes current key authority, resource and entitlement. */ });
        if (!current) return { ok: false, error: "broker_unavailable" };
        if ('authenticationFailure' in current) return { ok: false, error: current.authenticationFailure };
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
