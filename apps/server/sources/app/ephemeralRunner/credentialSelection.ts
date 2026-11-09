import * as z from 'zod/mini';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { RunnerCredentialSelectionBindingV1Schema } from "@happier-dev/protocol/ephemeralRunner/review";
import { RunnerCredentialSelectionResolutionRequestV1Schema, type RunnerCredentialSelectionResolutionRequestV1, type RunnerCredentialSelectionResolutionResponseV1 } from '@happier-dev/protocol/teams';
import { TeamCredentialRequestPolicyV1Schema } from '@happier-dev/protocol/teams/credentials/resourceV1';
import { type TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import { readTeamCredentialSourceBinding } from '@/app/teams/credentials/sourceBindingRead';

import {
    acquireAccountSessionOwnerMetadataFenceInTx,
    AccountSessionOwnerMetadataFenceAccountNotFoundError,
} from "@/app/encryption/accountSessionOwnerMetadataFence";
import type { SessionAccessAuthentication } from "@/app/session/access/sessionAccessAuthentication";
import { projectTeamCredentialProviderModels } from "@/app/teams/credentials/providerModelProjection";
import {
    readTeamCredentialBrokerPlacement,
    readTeamCredentialBrokerPresenceDemand,
    resolveTeamCredentialBrokerPlacementInTx,
} from "@/app/teams/credentials/brokerPlacementResolver";
import type {
    TeamCredentialPoolSourceEligibilityReader,
} from "@/app/teams/credentials/poolSourceEligibility";
import type { MachineDaemonPresenceInventory } from "@/app/machines/machineDaemonPresence";
import {
    resolvePlannedRunnerCredentialSelectionBindingInTx,
    validatePlannedSessionTeamCredentialResourceInTx,
} from "@/app/teams/credentials/sessionBinding";
import { inTx } from "@/storage/inTx";
import { readRunnerCreatorCurrentnessInTx, reconcileRunnerActivationCurrentnessInTx } from "./activationCurrentness";
import {
    StoredRunnerCredentialSelectionV1Schema,
    type StoredRunnerCredentialSelectionV1,
} from "./credentialSelectionRecord";
import { readRunnerActivationAuthentication } from "./activationAuthentication";
import { readRunnerConsentDisplayFactsInTx } from "./runnerConsentDisplayFacts";
import { acquireRunnerActivationLockInTx } from './activationLock';

type ProviderProjectionInput = Readonly<{
    custodianAccountId: string;
    brokerMachineId: string;
    source: TeamCredentialSourceBindingV1;
    request: RunnerCredentialSelectionResolutionRequestV1;
}>;

type CurrentSelection = Readonly<{
    binding: Readonly<{ v: 1; resourceId: string; brokerMachineId: string; revision: number }>;
    custodianAccountId: string;
    teamId: string;
    source: TeamCredentialSourceBindingV1;
    allowedModelIds: readonly string[] | null;
}>;

type SelectionPhase =
    | Readonly<{ ok: true; value: CurrentSelection }>
    | Readonly<{ ok: false; reason: Extract<RunnerCredentialSelectionResolutionResponseV1, { status: "unavailable" }>['reason'] }>;

type FrozenSelectionRead =
    | Readonly<{ status: "absent" }>
    | Readonly<{
        status: "resolved";
        value: StoredRunnerCredentialSelectionV1;
        displayFacts: NonNullable<Awaited<ReturnType<typeof readRunnerConsentDisplayFactsInTx>>>;
    }>
    | Readonly<{ status: "unavailable"; reason: Extract<RunnerCredentialSelectionResolutionResponseV1, { status: "unavailable" }>['reason'] }>;

async function readFrozenSelection(input: Readonly<{
    activationId: string;
    creatorAccountId: string;
    request: RunnerCredentialSelectionResolutionRequestV1;
    authentication: SessionAccessAuthentication;
}>): Promise<FrozenSelectionRead> {
    try {
        return await inTx(async (tx) => {
            const initial = await tx.ephemeralRunnerActivation.findUnique({ where: { id: input.activationId } });
            if (!initial || initial.creatorAccountId !== input.creatorAccountId) {
                return { status: "unavailable", reason: "activation_unavailable" } as const;
            }
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, initial.creatorAccountId, "content");
            await acquireRunnerActivationLockInTx(tx, input.activationId);
            const fenced = await tx.ephemeralRunnerActivation.findUnique({ where: { id: input.activationId } });
            if (!fenced || fenced.creatorAccountId !== input.creatorAccountId) {
                return { status: "unavailable", reason: "activation_unavailable" } as const;
            }
            const current = await readRunnerCreatorCurrentnessInTx(tx, fenced.creatorAccountId);
            const row = await reconcileRunnerActivationCurrentnessInTx(tx, fenced, current);
            if (current.status !== "ready" || row.state === "closed") {
                return { status: "unavailable", reason: "activation_unavailable" } as const;
            }
            if (row.state !== "claimed" || row.endpointFacts === null || row.review !== null) {
                return { status: "unavailable", reason: "activation_conflict" } as const;
            }
            if (row.credentialSelection === null) {
                // Entitlement comes before discovery. Selecting a Pool member
                // reads a foreign custodian's Machine presence and asks their
                // daemon whether it can run the source, so a caller who is not
                // entitled to this resource must not reach that step and must
                // not learn whether the id they named exists: a missing
                // resource and an existing one they cannot use refuse alike.
                // Revision, placement and broker Machine stay with the
                // selection itself, which re-enters this same planned-resource
                // owner before anything is frozen.
                const admitted = await validatePlannedSessionTeamCredentialResourceInTx(tx, {
                    accountId: input.creatorAccountId,
                    resourceId: input.request.selection.resourceId,
                    expectedResourceRevision: input.request.selection.expectedResourceRevision,
                    deliveryMode: "brokered",
                    plannedSession: input.request.plannedSession,
                    authentication: readRunnerActivationAuthentication(row, input.authentication.env),
                });
                if (!admitted.ok) {
                    return {
                        status: "unavailable",
                        reason: admitted.reason === "resource_missing" || admitted.reason === "resource_changed"
                            ? "access_removed"
                            : admitted.reason,
                    } as const;
                }
                return { status: "absent" } as const;
            }
            const stored = StoredRunnerCredentialSelectionV1Schema.safeParse(row.credentialSelection);
            if (!stored.success || !pluginJsonValuesEqual(stored.data.request, input.request)) {
                return { status: "unavailable", reason: "activation_conflict" } as const;
            }
            // This activation record remains the selection authority, but not
            // an authentication exemption: every recovery re-enters the same
            // planned-resource owner with this activation's credential snapshot.
            const currentBinding = await resolvePlannedRunnerCredentialSelectionBindingInTx(tx, {
                accountId: input.creatorAccountId,
                resourceId: input.request.selection.resourceId,
                expectedResourceRevision: input.request.selection.expectedResourceRevision,
                plannedSession: input.request.plannedSession,
                authentication: readRunnerActivationAuthentication(row, input.authentication.env),
                selectedBrokerMachineId: stored.data.binding.brokerMachineId,
                selection: "established",
            });
            if (!currentBinding.ok) return { status: "unavailable", reason: currentBinding.reason } as const;
            if (!pluginJsonValuesEqual(currentBinding.binding, {
                v: 1,
                resourceId: stored.data.binding.resourceId,
                brokerMachineId: stored.data.binding.brokerMachineId,
                revision: stored.data.binding.revision,
            })) {
                return { status: "unavailable", reason: "resource_changed" } as const;
            }
            const displayFacts = await readRunnerConsentDisplayFactsInTx({
                tx,
                homeServerIdentityId: row.homeServerIdentityId,
                creatorAccountId: input.creatorAccountId,
                teamId: input.request.selection.teamId,
            });
            return displayFacts
                ? { status: "resolved", value: stored.data, displayFacts } as const
                : { status: "unavailable", reason: "activation_unavailable" } as const;
        }, {
            // Creator fencing does not cover foreign Team/resource entitlement and broker bindings.
            isolationLevel: "Serializable",
        });
    } catch (error) {
        if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) {
            return { status: "unavailable", reason: "activation_unavailable" };
        }
        throw error;
    }
}

async function freezeSelection(input: Readonly<{
    activationId: string;
    creatorAccountId: string;
    request: RunnerCredentialSelectionResolutionRequestV1;
    authentication: SessionAccessAuthentication;
    binding: StoredRunnerCredentialSelectionV1["binding"];
}>): Promise<RunnerCredentialSelectionResolutionResponseV1> {
    try {
        return await inTx(async (tx) => {
            const initial = await tx.ephemeralRunnerActivation.findUnique({ where: { id: input.activationId } });
            if (!initial || initial.creatorAccountId !== input.creatorAccountId) {
                return { v: 1, status: "unavailable", reason: "activation_unavailable" } as const;
            }
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, initial.creatorAccountId, "content");
            await acquireRunnerActivationLockInTx(tx, input.activationId);
            const fenced = await tx.ephemeralRunnerActivation.findUnique({ where: { id: input.activationId } });
            if (!fenced || fenced.creatorAccountId !== input.creatorAccountId) {
                return { v: 1, status: "unavailable", reason: "activation_unavailable" } as const;
            }
            const current = await readRunnerCreatorCurrentnessInTx(tx, fenced.creatorAccountId);
            const row = await reconcileRunnerActivationCurrentnessInTx(tx, fenced, current);
            if (current.status !== "ready" || row.state === "closed") {
                return { v: 1, status: "unavailable", reason: "activation_unavailable" } as const;
            }
            if (row.state !== "claimed" || row.endpointFacts === null || row.review !== null) {
                return { v: 1, status: "unavailable", reason: "activation_conflict" } as const;
            }
            if (row.credentialSelection !== null) {
                const stored = StoredRunnerCredentialSelectionV1Schema.safeParse(row.credentialSelection);
                if (!stored.success || !pluginJsonValuesEqual(stored.data.request, input.request)) {
                    return { v: 1, status: "unavailable", reason: "activation_conflict" } as const;
                }
                const currentBinding = await resolvePlannedRunnerCredentialSelectionBindingInTx(tx, {
                    accountId: input.creatorAccountId,
                    resourceId: input.request.selection.resourceId,
                    expectedResourceRevision: input.request.selection.expectedResourceRevision,
                    plannedSession: input.request.plannedSession,
                    authentication: readRunnerActivationAuthentication(row, input.authentication.env),
                    selectedBrokerMachineId: stored.data.binding.brokerMachineId,
                    selection: "established",
                });
                if (!currentBinding.ok) return { v: 1, status: "unavailable", reason: currentBinding.reason } as const;
                if (!pluginJsonValuesEqual(currentBinding.binding, {
                    v: 1,
                    resourceId: stored.data.binding.resourceId,
                    brokerMachineId: stored.data.binding.brokerMachineId,
                    revision: stored.data.binding.revision,
                })) {
                    return { v: 1, status: "unavailable", reason: "resource_changed" } as const;
                }
                const displayFacts = await readRunnerConsentDisplayFactsInTx({
                    tx,
                    homeServerIdentityId: row.homeServerIdentityId,
                    creatorAccountId: input.creatorAccountId,
                    teamId: input.request.selection.teamId,
                });
                return displayFacts
                    ? { v: 1, status: "resolved", credentialSelectionBinding: stored.data.binding, displayFacts } as const
                    : { v: 1, status: "unavailable", reason: "activation_unavailable" } as const;
            }
            const currentBinding = await resolvePlannedRunnerCredentialSelectionBindingInTx(tx, {
                accountId: input.creatorAccountId,
                resourceId: input.request.selection.resourceId,
                expectedResourceRevision: input.request.selection.expectedResourceRevision,
                plannedSession: input.request.plannedSession,
                authentication: readRunnerActivationAuthentication(row, input.authentication.env),
                selectedBrokerMachineId: input.binding.brokerMachineId,
                selection: "per_request",
            });
            if (!currentBinding.ok) return { v: 1, status: "unavailable", reason: currentBinding.reason } as const;
            if (!pluginJsonValuesEqual(currentBinding.binding, {
                v: 1,
                resourceId: input.binding.resourceId,
                brokerMachineId: input.binding.brokerMachineId,
                revision: input.binding.revision,
            })) return { v: 1, status: "unavailable", reason: "resource_changed" } as const;
            const stored = StoredRunnerCredentialSelectionV1Schema.parse({
                v: 1,
                request: input.request,
                binding: input.binding,
            });
            await tx.ephemeralRunnerActivation.update({
                where: { id: row.id },
                data: { credentialSelection: stored },
            });
            const displayFacts = await readRunnerConsentDisplayFactsInTx({
                tx,
                homeServerIdentityId: row.homeServerIdentityId,
                creatorAccountId: input.creatorAccountId,
                teamId: input.request.selection.teamId,
            });
            return displayFacts
                ? { v: 1, status: "resolved", credentialSelectionBinding: stored.binding, displayFacts } as const
                : { v: 1, status: "unavailable", reason: "activation_unavailable" } as const;
        }, {
            // Freeze one coherent foreign Team/resource entitlement and broker selection.
            isolationLevel: "Serializable",
        });
    } catch (error) {
        if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) {
            return { v: 1, status: "unavailable", reason: "activation_unavailable" };
        }
        throw error;
    }
}

export type RunnerBrokerPresenceReader =
    (custodianAccountId: string, machineIds: readonly string[]) => Promise<MachineDaemonPresenceInventory>;

type RunnerBrokerMachineSelection =
    | Readonly<{ ok: true; brokerMachineId: string | null }>
    | Readonly<{ ok: false; reason: Extract<RunnerCredentialSelectionResolutionResponseV1, { status: "unavailable" }>['reason'] }>;

/**
 * Resolves the one exact broker Machine this activation will be bound to.
 *
 * An exact placement already names its Machine, so nothing is selected here.
 * A Pool placement is ranked once, through the same placement owner every other
 * broker ingress uses: candidates first, then the source-eligible members. The
 * winner is then frozen into the activation's binding and revalidated as a
 * current member on every later read, never reranked — so membership edits
 * after review cannot move a reviewed activation onto another Machine.
 */
async function selectRunnerBrokerMachine(input: Readonly<{
    activationId: string;
    request: RunnerCredentialSelectionResolutionRequestV1;
    readCurrentPresence: RunnerBrokerPresenceReader;
    readPoolSourceEligibility: TeamCredentialPoolSourceEligibilityReader;
    signal: AbortSignal;
}>): Promise<RunnerBrokerMachineSelection> {
    const resource = await inTx(tx => tx.teamCredentialResource.findUnique({
        where: { id: input.request.selection.resourceId },
        select: {
            id: true,
            teamId: true,
            custodianAccountId: true,
            revision: true,
            sourceBindingJson: true,
            brokerMachineId: true,
            brokerPoolId: true,
        },
    }));
    if (!resource) return { ok: false, reason: "resource_missing" };
    if (resource.teamId !== input.request.selection.teamId
        || resource.revision !== input.request.selection.expectedResourceRevision) {
        return { ok: false, reason: "resource_changed" };
    }
    const placement = readTeamCredentialBrokerPlacement(resource);
    if (!placement.ok) return { ok: false, reason: "resource_corrupt" };
    if (placement.placement === null) return { ok: false, reason: "broker_unavailable" };
    if (placement.placement.kind === "machine") return { ok: true, brokerMachineId: null };

    const source = readTeamCredentialSourceBinding(resource.sourceBindingJson);
    if (!source.success) return { ok: false, reason: "resource_corrupt" };

    let presence: MachineDaemonPresenceInventory;
    try {
        const machineIds = await readTeamCredentialBrokerPresenceDemand({ resource });
        presence = await input.readCurrentPresence(resource.custodianAccountId, machineIds);
    } catch {
        return { ok: false, reason: "broker_unavailable" };
    }
    // The activation is this selection's identity, so a retried resolution for
    // the same activation ranks the same members in the same order.
    const requestKey = [resource.id, "runner_activation", input.activationId].join("\u0000");
    const placementResource = {
        id: resource.id,
        custodianAccountId: resource.custodianAccountId,
        brokerMachineId: resource.brokerMachineId,
        brokerPoolId: resource.brokerPoolId,
    };
    const candidates = await inTx(tx => resolveTeamCredentialBrokerPlacementInTx(tx, {
        resource: placementResource,
        presence,
        requestKey,
    }));
    if (!candidates.ok || candidates.poolSnapshot === null || candidates.candidateMachineIds.length === 0) {
        return { ok: false, reason: "broker_unavailable" };
    }
    let eligibility: Awaited<ReturnType<TeamCredentialPoolSourceEligibilityReader>>;
    try {
        eligibility = await input.readPoolSourceEligibility({
            custodianAccountId: resource.custodianAccountId,
            machineIds: candidates.candidateMachineIds,
            teamId: resource.teamId,
            resourceId: resource.id,
            resourceRevision: resource.revision,
            source: source.data,
            application: input.request.application,
            modelId: input.request.selection.modelId,
            sourceRevision: input.request.sourceRevision,
            signal: input.signal,
        });
    } catch {
        return { ok: false, reason: "broker_unavailable" };
    }
    if (input.signal.aborted) return { ok: false, reason: "broker_unavailable" };
    const selected = await inTx(tx => resolveTeamCredentialBrokerPlacementInTx(tx, {
        resource: placementResource,
        presence,
        requestKey,
        poolEligibleMachineIds: eligibility.eligibleMachineIds,
    }));
    if (!selected.ok || selected.broker === null) return { ok: false, reason: "broker_unavailable" };
    return { ok: true, brokerMachineId: selected.broker.machineId };
}

async function readCurrentSelection(input: Readonly<{
    activationId: string;
    creatorAccountId: string;
    request: RunnerCredentialSelectionResolutionRequestV1;
    authentication: SessionAccessAuthentication;
    selectedBrokerMachineId?: string;
}>): Promise<SelectionPhase> {
    try {
        return await inTx(async (tx) => {
            const initial = await tx.ephemeralRunnerActivation.findUnique({ where: { id: input.activationId } });
            if (!initial || initial.creatorAccountId !== input.creatorAccountId) {
                return { ok: false, reason: "activation_unavailable" } as const;
            }
            await acquireAccountSessionOwnerMetadataFenceInTx(tx, initial.creatorAccountId, "content");
            await acquireRunnerActivationLockInTx(tx, input.activationId);
            const fenced = await tx.ephemeralRunnerActivation.findUnique({ where: { id: input.activationId } });
            if (!fenced || fenced.creatorAccountId !== input.creatorAccountId) {
                return { ok: false, reason: "activation_unavailable" } as const;
            }
            const current = await readRunnerCreatorCurrentnessInTx(tx, fenced.creatorAccountId);
            const row = await reconcileRunnerActivationCurrentnessInTx(tx, fenced, current);
            if (current.status !== "ready" || row.state === "closed") {
                return { ok: false, reason: "activation_unavailable" } as const;
            }
            if (row.state !== "claimed" || row.endpointFacts === null || row.review !== null) {
                return { ok: false, reason: "activation_conflict" } as const;
            }
            const resource = await tx.teamCredentialResource.findUnique({
                where: { id: input.request.selection.resourceId },
                select: {
                    teamId: true,
                    custodianAccountId: true,
                    sourceBindingJson: true,
                    requestPolicyJson: true,
                },
            });
            if (!resource) return { ok: false, reason: "resource_missing" } as const;
            if (resource.teamId !== input.request.selection.teamId) {
                return { ok: false, reason: "resource_changed" } as const;
            }
            let rawPolicy: unknown = null;
            try {
                rawPolicy = resource.requestPolicyJson === null ? null : JSON.parse(resource.requestPolicyJson);
            } catch {
                return { ok: false, reason: "resource_corrupt" } as const;
            }
            const source = readTeamCredentialSourceBinding(resource.sourceBindingJson);
            const policy = z.nullable(TeamCredentialRequestPolicyV1Schema).safeParse(rawPolicy);
            if (!source.success || !policy.success) return { ok: false, reason: "resource_corrupt" } as const;
            const resolved = await resolvePlannedRunnerCredentialSelectionBindingInTx(tx, {
                accountId: input.creatorAccountId,
                resourceId: input.request.selection.resourceId,
                expectedResourceRevision: input.request.selection.expectedResourceRevision,
                plannedSession: input.request.plannedSession,
                authentication: readRunnerActivationAuthentication(row, input.authentication.env),
                ...(input.selectedBrokerMachineId ? { selectedBrokerMachineId: input.selectedBrokerMachineId } : {}),
            });
            if (!resolved.ok) return resolved;
            return { ok: true, value: {
                binding: resolved.binding,
                custodianAccountId: resource.custodianAccountId,
                teamId: resource.teamId,
                source: source.data,
                allowedModelIds: policy.data?.allowedModelIds ?? null,
            } } as const;
        }, {
            // Resource policy and entitlement must describe the same broker selection snapshot.
            isolationLevel: "Serializable",
        });
    } catch (error) {
        if (error instanceof AccountSessionOwnerMetadataFenceAccountNotFoundError) {
            return { ok: false, reason: "activation_unavailable" };
        }
        throw error;
    }
}

/**
 * Authenticated, bounded pre-Session resolution for the resource owner's exact
 * persistent broker Machine. It performs no model request, credential export,
 * Session allocation, lease, Pool placement, or token lifecycle.
 */
export async function resolveRunnerCredentialSelection(input: Readonly<{
    activationId: string;
    creatorAccountId: string;
    request: unknown;
    authentication: SessionAccessAuthentication;
    readProviderProjection: (input: ProviderProjectionInput) => Promise<unknown>;
    readCurrentPresence: RunnerBrokerPresenceReader;
    readPoolSourceEligibility: TeamCredentialPoolSourceEligibilityReader;
    signal: AbortSignal;
}>): Promise<RunnerCredentialSelectionResolutionResponseV1> {
    const request = RunnerCredentialSelectionResolutionRequestV1Schema.safeParse(input.request);
    if (!request.success) return { v: 1, status: "unavailable", reason: "invalid_input" };
    const frozen = await readFrozenSelection({ ...input, request: request.data });
    if (frozen.status === "unavailable") return { v: 1, status: "unavailable", reason: frozen.reason };
    if (frozen.status === "resolved") {
        return { v: 1, status: "resolved", credentialSelectionBinding: frozen.value.binding, displayFacts: frozen.displayFacts };
    }
    const placement = await selectRunnerBrokerMachine({
        activationId: input.activationId,
        request: request.data,
        readCurrentPresence: input.readCurrentPresence,
        readPoolSourceEligibility: input.readPoolSourceEligibility,
        signal: input.signal,
    });
    if (!placement.ok) return { v: 1, status: "unavailable", reason: placement.reason };
    const selectedBrokerScope = placement.brokerMachineId === null
        ? {}
        : { selectedBrokerMachineId: placement.brokerMachineId };
    const before = await readCurrentSelection({ ...input, ...selectedBrokerScope, request: request.data });
    if (!before.ok) return { v: 1, status: "unavailable", reason: before.reason };
    let response: unknown;
    try {
        response = await input.readProviderProjection({
            custodianAccountId: before.value.custodianAccountId,
            brokerMachineId: before.value.binding.brokerMachineId,
            source: before.value.source,
            request: request.data,
        });
    } catch {
        return { v: 1, status: "unavailable", reason: "application_unavailable" };
    }
    const candidates = projectTeamCredentialProviderModels({
        response,
        resourceId: before.value.binding.resourceId,
        teamId: before.value.teamId,
        resourceRevision: before.value.binding.revision,
        agentTargetKey: request.data.selection.agentTargetKey,
        application: request.data.application,
        allowedModelIds: before.value.allowedModelIds,
        source: before.value.source,
        deliveryMode: "brokered",
    });
    const selected = candidates.models.find(candidate => (
        candidate.selection.modelId === request.data.selection.modelId
        && candidate.sourceRevision === request.data.sourceRevision
        && pluginJsonValuesEqual(candidate.application, request.data.application)
    ));
    if (!selected) {
        const sourceStillPresent = candidates.models.some(candidate => candidate.sourceRevision === request.data.sourceRevision);
        return { v: 1, status: "unavailable", reason: sourceStillPresent ? "model_unavailable" : "source_changed" };
    }
    const after = await readCurrentSelection({ ...input, ...selectedBrokerScope, request: request.data });
    if (!after.ok) return { v: 1, status: "unavailable", reason: after.reason };
    if (!pluginJsonValuesEqual(before.value.binding, after.value.binding)) {
        return { v: 1, status: "unavailable", reason: "resource_changed" };
    }
    return await freezeSelection({
        activationId: input.activationId,
        creatorAccountId: input.creatorAccountId,
        request: request.data,
        authentication: input.authentication,
        binding: RunnerCredentialSelectionBindingV1Schema.parse({
            ...after.value.binding,
            application: request.data.application,
            sourceRevision: request.data.sourceRevision,
        }),
    });
}
