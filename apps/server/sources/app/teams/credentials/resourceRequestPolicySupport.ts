import { isDeepStrictEqual } from "node:util";
import { TeamCredentialRequestPolicySupportOutputV1Schema, type TeamCredentialBrokerPlacementV1, type TeamCredentialRequestPolicyModelSupportV1, type TeamCredentialRequestPolicyV1, type TeamCredentialRequestPolicySupportOutputV1 } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { type TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import { readTeamCredentialSourceBinding } from './sourceBindingRead';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { DaemonProviderTeamCredentialRequestPolicySupportResponseV1Schema } from '@happier-dev/protocol/rpc/providers';

import type { Tx } from "@/storage/inTx";
import type { Fastify } from "@/app/api/types";
import { classifyMachineDaemonPresence, getMachineDaemonPresenceInventory } from "@/app/machines/machineDaemonPresence";
import { getMachinePoolCandidateSnapshot } from "@/app/machines/pools/machinePoolService";
import { resolveTeamActorContextInTx, type TeamOperationAuthenticationContext } from "../actorContext";
import { resolveTeamCredentialCapabilities } from "../capabilities";
import { readTeamCredentialBrokerPlacement, validateTeamCredentialBrokerPlacementForSaveInTx } from "./brokerPlacementResolver";
import { qualifyTeamCredentialOperationInTx } from "./resourceRead";
import { resolveTeamCredentialResourceSourceInTx } from "./resourceSourceResolver";
import type { TeamCredentialResourceSourceCurrentness } from "./resourceSourceResolver";
import {
    projectTeamCredentialRequestPolicySupportModels,
    selectPoolBackedTeamCredentialRequestPolicySupportModels,
} from "./providerModelProjection";

export type TeamCredentialRequestPolicySupportPreparation = Readonly<{
    ok: true;
    teamId: string;
    custodianAccountId: string;
    source: TeamCredentialSourceBindingV1;
    brokerPlacement: TeamCredentialBrokerPlacementV1;
    sourceCurrentness: TeamCredentialResourceSourceCurrentness;
}> | Readonly<{
    ok: false;
    error: "not_found_or_not_visible" | "resource_not_found" | "resource_forbidden"
        | "resource_corrupt" | "team_authentication_required" | "team_authentication_policy_unavailable";
}> | Readonly<{
    ok: false;
    unavailable: "broker_unavailable" | "source_unavailable" | "update_required" | 'connected_service_credential_reconnect_required';
}>;

type SupportInput = Readonly<{
    actorAccountId: string;
    authentication: TeamOperationAuthenticationContext;
}> & (
    | Readonly<{
        scope: "source_draft";
        teamId: string;
        source: TeamCredentialSourceBindingV1;
        brokerPlacement: TeamCredentialBrokerPlacementV1 | null;
    }>
    | Readonly<{
        scope: "resource";
        resourceId: string;
        custodian?: Readonly<{
            source: TeamCredentialSourceBindingV1;
            brokerPlacement: TeamCredentialBrokerPlacementV1 | null;
        }>;
    }>
);

export type TeamCredentialRequestPolicySupportEvidence = Readonly<{
    source: TeamCredentialSourceBindingV1;
    sourceCurrentness: TeamCredentialResourceSourceCurrentness;
    models: readonly TeamCredentialRequestPolicyModelSupportV1[];
}>;

/**
 * Validates a policy only against positive source-owned support and returns the
 * canonical document that may be persisted. Persisted allow-lists accept only
 * descriptor ids so an exact create retry can be rejoined without consulting
 * a daemon after the first response is lost.
 */
export function normalizeTeamCredentialRequestPolicyForPersistence(input: Readonly<{
    policy: TeamCredentialRequestPolicyV1;
    models: readonly TeamCredentialRequestPolicyModelSupportV1[];
}>): TeamCredentialRequestPolicyV1 | null {
    if (input.models.length === 0) return null;
    const canonicalModelIds = input.policy.allowedModelIds === null
        ? null
        : input.policy.allowedModelIds.every((modelId) => (
            input.models.some((candidate) => candidate.descriptor.id === modelId)
        ))
            ? input.policy.allowedModelIds
            : null;
    if (input.policy.allowedModelIds !== null && canonicalModelIds === null) return null;
    const normalizedPolicy: TeamCredentialRequestPolicyV1 = {
        ...input.policy,
        allowedModelIds: canonicalModelIds === null
            ? null
            : [...new Set(canonicalModelIds)],
    };
    const selected = normalizedPolicy.allowedModelIds === null
        ? input.models
        : input.models.filter((candidate) => normalizedPolicy.allowedModelIds!.includes(candidate.descriptor.id));
    if (selected.length === 0) return null;
    if (normalizedPolicy.allowedProtocolKinds !== null && normalizedPolicy.allowedProtocolKinds.some((protocol) => (
        selected.some((model) => !model.allowedProtocolKinds.includes(protocol))
    ))) return null;
    if (normalizedPolicy.reasoningEffort !== null && selected.some((model) => {
        const support = model.reasoningEffort;
        return support === null
            || !normalizedPolicy.reasoningEffort!.allowedValues.every((value) => support.allowedValues.includes(value))
            || !support.allowedValues.includes(normalizedPolicy.reasoningEffort!.defaultValue);
    })) return null;
    return normalizedPolicy;
}

export function isTeamCredentialRequestPolicySupportEvidenceCurrent(input: Readonly<{
    evidence: TeamCredentialRequestPolicySupportEvidence;
    source: TeamCredentialSourceBindingV1;
    sourceCurrentness: TeamCredentialResourceSourceCurrentness;
}>): boolean {
    // Connected Account and Pool snapshots re-authenticate their persisted
    // configuration/incarnation facts here. Provider settings remain E2EE, so
    // Home can re-authenticate only the exact persisted Provider source binding;
    // daemon-owned sourceRevision/application currentness stays runtime-owned.
    return isDeepStrictEqual(input.evidence.source, input.source)
        && isDeepStrictEqual(input.evidence.sourceCurrentness, input.sourceCurrentness);
}

/**
 * Resolves request-policy support authority and private source topology once.
 * The route consumes this result but never projects the source, placement, or
 * custodian identity to the caller.
 */
export async function prepareTeamCredentialRequestPolicySupportInTx(
    tx: Tx,
    input: SupportInput,
): Promise<TeamCredentialRequestPolicySupportPreparation> {
    let teamId: string;
    let custodianAccountId: string;
    let source: TeamCredentialSourceBindingV1;
    let brokerPlacement: TeamCredentialBrokerPlacementV1 | null;

    if (input.scope === "source_draft") {
        teamId = input.teamId;
        custodianAccountId = input.actorAccountId;
        source = input.source;
        brokerPlacement = input.brokerPlacement;
    } else {
        const resource = await tx.teamCredentialResource.findUnique({
            where: { id: input.resourceId },
            select: {
                teamId: true,
                custodianAccountId: true,
                sourceBindingJson: true,
                brokerMachineId: true,
                brokerPoolId: true,
            },
        });
        if (!resource) return { ok: false, error: "resource_not_found" };
        const parsedSource = readTeamCredentialSourceBinding(resource.sourceBindingJson);
        const parsedPlacement = readTeamCredentialBrokerPlacement(resource);
        if (!parsedSource.success || !parsedPlacement.ok) {
            return { ok: false, error: "resource_corrupt" };
        }
        teamId = resource.teamId;
        custodianAccountId = resource.custodianAccountId;
        source = parsedSource.data;
        brokerPlacement = parsedPlacement.placement;
    }

    const actor = await resolveTeamActorContextInTx(tx, {
        teamId,
        actorAccountId: input.actorAccountId,
    });
    if (!actor) return { ok: false, error: "not_found_or_not_visible" };
    const capabilities = resolveTeamCredentialCapabilities({
        ...actor,
        teamArchivedAt: actor.team.archivedAt,
    });
    const isCurrentCustodian = custodianAccountId === input.actorAccountId
        && capabilities.offerOwnCredential;
    if (input.scope === "resource" && input.custodian !== undefined && !isCurrentCustodian) {
        return { ok: false, error: "resource_forbidden" };
    }
    if (!isCurrentCustodian && !capabilities.manageCredentials) {
        return { ok: false, error: "resource_forbidden" };
    }
    const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, input.authentication);
    if (!qualification.ok) return qualification;

    if (input.scope === "resource" && input.custodian !== undefined) {
        source = input.custodian.source;
        brokerPlacement = input.custodian.brokerPlacement;
    }
    const currentSource = await resolveTeamCredentialResourceSourceInTx(tx, {
        custodianAccountId,
        source,
    });
    if (currentSource.status !== "current") {
        return { ok: false, unavailable: "source_unavailable" };
    }
    if (currentSource.authenticationFailure) return { ok: false, unavailable: currentSource.authenticationFailure };
    if (brokerPlacement === null) return { ok: false, unavailable: "broker_unavailable" };
    const placement = await validateTeamCredentialBrokerPlacementForSaveInTx(tx, {
        custodianAccountId,
        placement: brokerPlacement,
    });
    if (!placement.ok) return { ok: false, unavailable: placement.error };
    return {
        ok: true,
        teamId,
        custodianAccountId,
        source,
        brokerPlacement,
        sourceCurrentness: currentSource.requestPolicyCurrentness,
    };
}

/**
 * The one interpreter of daemon broker refusals: a refusal is reported only
 * when every candidate observation agrees on the same reason.
 */
export function readTeamCredentialBrokerRefusalReason(reasons: readonly (string | null)[]) {
    const first = reasons[0];
    return (first === 'application_unavailable' || first === 'model_unavailable' || first === 'response_invalid')
        && reasons.every(reason => reason === first)
        ? first
        : null;
}

/**
 * Calls the one daemon-owned source/application discovery contract and narrows
 * its answer to the value-free Team editor projection. This is shared by the
 * public support action and update preflight so neither path authors Provider
 * application identity or infers support from a source kind.
 */
export async function resolveTeamCredentialRequestPolicySupport(
    app: Fastify,
    prepared: Extract<TeamCredentialRequestPolicySupportPreparation, { ok: true }>,
): Promise<TeamCredentialRequestPolicySupportOutputV1> {
    const presence = prepared.brokerPlacement.kind === 'machine' ? await getMachineDaemonPresenceInventory({
        accountId: prepared.custodianAccountId,
        io: app.machineDaemonPresence,
        machineIds: [prepared.brokerPlacement.machineId],
    }) : null;
    const poolSnapshot = prepared.brokerPlacement.kind === "machine_pool"
        ? await getMachinePoolCandidateSnapshot({
            accountId: prepared.custodianAccountId,
            poolId: prepared.brokerPlacement.poolId,
            io: app.machineDaemonPresence,
        })
        : null;
    const machineIds = prepared.brokerPlacement.kind === "machine"
        ? presence && classifyMachineDaemonPresence(presence, prepared.brokerPlacement.machineId) === "connected"
            ? [prepared.brokerPlacement.machineId]
            : []
        : poolSnapshot?.ok
            ? poolSnapshot.value.members.flatMap(member => (
                member.enabled && poolSnapshot.value.availableMachineIds.has(member.machineId)
                    ? [member.machineId]
                    : []
            ))
            : [];
    if (machineIds.length === 0) {
        return { status: "unavailable", reason: "broker_unavailable" };
    }

    const projections = await Promise.all(machineIds.map(async machineId => {
        const rpcResult = await app.forwardRpcForUser({
            userId: prepared.custodianAccountId,
            method: `${machineId}:${RPC_METHODS.DAEMON_PROVIDERS_TEAM_CREDENTIAL_REQUEST_POLICY_SUPPORT}`,
            params: {
                machineId,
                source: prepared.source,
                ...(poolSnapshot?.ok ? { refreshPolicy: "current_only" as const } : {}),
            },
        });
        if (!rpcResult.ok) return { machineId, response: null, models: [] };
        return {
            machineId,
            response: rpcResult.result,
            models: [...projectTeamCredentialRequestPolicySupportModels(rpcResult.result)],
        };
    }));
    const projected = poolSnapshot?.ok
        ? selectPoolBackedTeamCredentialRequestPolicySupportModels({
            members: poolSnapshot.value.members,
            availableMachineIds: poolSnapshot.value.availableMachineIds,
            candidates: projections.flatMap(({ machineId, models }) => (
                models.map(model => ({ machineId, model }))
            )),
            requestKey: `credential-request-policy-support\u0000${prepared.teamId}`,
        })
        : projections.flatMap(projection => projection.models);
    if (projected.length > 0) {
        const byModelAndApplication = new Map<string, typeof projected[number]>();
        for (const model of projected) {
            byModelAndApplication.set(JSON.stringify([
                model.descriptor.id,
                model.application,
                model.sourceRevision,
            ]), model);
        }
        return TeamCredentialRequestPolicySupportOutputV1Schema.parse({
            status: "available",
            models: [...byModelAndApplication.values()],
        });
    }
    const parsedResponses = projections.map(({ response }) => {
        const parsed = DaemonProviderTeamCredentialRequestPolicySupportResponseV1Schema.safeParse(response);
        return parsed.success ? parsed.data : null;
    });
    if (parsedResponses.some(response => response?.status === 'unavailable'
        && response.reason === 'connected_service_credential_reconnect_required')) {
        return { status: 'unavailable', reason: 'connected_service_credential_reconnect_required' };
    }
    // A refusal is a Pool-wide fact only when every observed candidate agrees;
    // mixed, missing or malformed observations stay `broker_unavailable`.
    const refusal = readTeamCredentialBrokerRefusalReason(parsedResponses.map(response => (
        response?.status === "unavailable" ? response.reason : null
    )));
    const reason = parsedResponses.some(response => response?.status === "success")
        ? "update_required"
        : refusal === "application_unavailable"
            ? "unsupported_application"
            : refusal === "model_unavailable"
                ? "model_catalog_unavailable"
                : parsedResponses.some(response => response?.status === "unavailable" && response.reason === "source_unavailable")
                    ? "source_unavailable"
                    : "broker_unavailable";
    return TeamCredentialRequestPolicySupportOutputV1Schema.parse({ status: "unavailable", reason });
}
