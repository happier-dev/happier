import { readMachineIrohEndpointAuthorityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { type RunnerBrokerReadinessRequestV1 } from '@happier-dev/protocol/ephemeralRunner/brokerReadinessRequestV1';
import { type TeamCredentialResourceReadinessV1, type RunnerBrokerReadinessProjectionV1 } from '@happier-dev/protocol/teams/credentials/readinessV1';
import { type RunnerCredentialSelectionBindingV1 } from '@happier-dev/protocol/ephemeralRunner/review';

import { verifyRunnerBrokerReadinessCurrentnessInTx } from "@/app/ephemeralRunner/runnerBrokerReadinessVerification";
import { inTx } from "@/storage/inTx";
import type { Tx } from "@/storage/inTx";
import { resolveTeamCredentialEntitlementInTx } from "./resourceAccess";
import { resolveTeamCredentialResourceSourceInTx } from "./resourceSourceResolver";
import { resolveTeamActorContextInTx, type TeamOperationAuthenticationContext } from "../actorContext";
import { qualifyTeamCredentialOperationInTx } from "./resourceRead";
import { readRunnerActivationAuthentication } from "@/app/ephemeralRunner/activationAuthentication";
import { readRunnerCreatorCurrentnessInTx } from "@/app/ephemeralRunner/activationCurrentness";
import { readEligibleBrokerMachineInTx } from "./brokerMachineEligibility";
import { isTeamCredentialBrokerPlacementBoundToMachineInTx } from "./brokerPlacementResolver";
import { readTeamCredentialSourceBinding } from './sourceBindingRead';
import { projectSourceAuthenticationReadiness } from './sourceReadiness';

export type RunnerBrokerReadinessAuthorization = Readonly<{
    ok: true;
    request: RunnerBrokerReadinessRequestV1;
    readiness: TeamCredentialResourceReadinessV1;
    credentialSelectionBinding: RunnerCredentialSelectionBindingV1;
}> | Readonly<{
    ok: false;
    error: "team_authentication_required" | "team_authentication_policy_unavailable";
}>;

/** Proof-bound endpoint projection before it can construct the signed carrier request. */
export async function readRunnerBrokerReadinessProjectionInTx(
    tx: Tx,
    input: Readonly<{ activationId: string; selection: RunnerCredentialSelectionBindingV1; env?: NodeJS.ProcessEnv }>,
): Promise<RunnerBrokerReadinessProjectionV1 | null> {
    const activation = await tx.ephemeralRunnerActivation.findUnique({ where: { id: input.activationId } });
    if (!activation || activation.state === "closed") return null;
    const creatorCurrentness = await readRunnerCreatorCurrentnessInTx(tx, activation.creatorAccountId);
    if (creatorCurrentness.status !== "ready" || creatorCurrentness.creatorTokenEpoch !== activation.creatorTokenEpoch) {
        return null;
    }
    const resource = await tx.teamCredentialResource.findUnique({
        where: { id: input.selection.resourceId },
        select: { id: true, teamId: true, custodianAccountId: true, revision: true, sourceBindingJson: true, brokerMachineId: true, brokerPoolId: true },
    });
    // The selection is the activation's own reviewed binding, so this is an
    // established target: current resource, source, Machine and endpoint
    // authority are revalidated below, but Pool membership edits after the
    // freeze do not revoke it.
    if (!resource || resource.revision !== input.selection.revision
        || !await isTeamCredentialBrokerPlacementBoundToMachineInTx(tx, {
            resource,
            machineId: input.selection.brokerMachineId,
            selection: "established",
        })) return null;
    const entitlement = await resolveTeamCredentialEntitlementInTx(tx, {
        resourceId: resource.id, accountId: activation.creatorAccountId,
    });
    if (!entitlement.ok || !entitlement.mayBroker) return null;
    const actor = await resolveTeamActorContextInTx(tx, {
        teamId: resource.teamId,
        actorAccountId: activation.creatorAccountId,
    });
    if (!actor) return null;
    const activationAuthentication = readRunnerActivationAuthentication(activation, input.env ?? process.env);
    const qualification = await qualifyTeamCredentialOperationInTx(tx, actor, {
        authenticationAuthority: activationAuthentication.authority,
        authenticationEvidence: activationAuthentication.authenticationEvidence,
        env: activationAuthentication.env,
    });
    if (!qualification.ok) return null;
    const source = readTeamCredentialSourceBinding(resource.sourceBindingJson);
    if (!source.success) return null;
    const sourceResolution = await resolveTeamCredentialResourceSourceInTx(tx, {
        custodianAccountId: resource.custodianAccountId, source: source.data,
    });
    if (sourceResolution.status !== "current") return null;
    // The broker is the exact Machine frozen into this activation's binding, not
    // the resource's placement column: a Pool placement has no column of its own.
    const eligibleBroker = await readEligibleBrokerMachineInTx(tx, {
        custodianAccountId: resource.custodianAccountId,
        brokerMachineId: input.selection.brokerMachineId,
    });
    if (!eligibleBroker.ok) return null;
    const { machine } = eligibleBroker;
    const endpoint = readMachineIrohEndpointAuthorityV1({ capabilities: machine.operationProtocolCapabilities,
        revision: machine.operationProtocolCapabilitiesRevision });
    return endpoint ? {
        credentialSelectionBinding: input.selection,
        target: {
            endpointId: endpoint.endpointId,
            ...(endpoint.relayUrls ? { relayUrls: [...endpoint.relayUrls] } : {}),
            ...(endpoint.directAddresses ? { directAddresses: [...endpoint.directAddresses] } : {}),
        },
        provider: { identity: input.selection.application.implementationIdentity, definitionRevision: 1 },
        readiness: projectSourceAuthenticationReadiness(sourceResolution) ?? { kind: "available" },
    } : null;
}

/** Content-free Home authorization. It creates no Session, Machine, key, usage, or lease. */
export async function authorizeRunnerBrokerReadiness(input: Readonly<{
    custodianAccountId: string;
    resourceId: string;
    request: unknown;
    authentication: TeamOperationAuthenticationContext;
}>): Promise<RunnerBrokerReadinessAuthorization | null> {
    return await inTx(async (tx) => {
        const activation = await verifyRunnerBrokerReadinessCurrentnessInTx(tx, {
            activationId: (input.request as { activationId?: string } | null)?.activationId ?? "",
            request: input.request,
        });
        if (!activation || activation.resourceId !== input.resourceId) return null;
        const resource = await tx.teamCredentialResource.findUnique({ where: { id: input.resourceId } });
        if (!resource || resource.custodianAccountId !== input.custodianAccountId) return null;
        const actor = await resolveTeamActorContextInTx(tx, {
            teamId: resource.teamId,
            actorAccountId: activation.creatorAccountId,
        });
        if (!actor) return null;
        const qualification = await qualifyTeamCredentialOperationInTx(
            tx,
            actor,
            {
                env: input.authentication.env,
                authenticationAuthority: "account_automation",
                authenticationEvidence: activation.authenticationEvidence,
            },
        );
        if (!qualification.ok) return qualification;
        if (resource.revision !== activation.resourceRevision
            || !await isTeamCredentialBrokerPlacementBoundToMachineInTx(tx, {
                resource,
                machineId: activation.brokerMachineId,
                selection: "established",
            })) {
            return { ok: true, request: activation.request, credentialSelectionBinding: activation.credentialSelectionBinding, readiness: { kind: "resource_unavailable" } };
        }
        const entitlement = await resolveTeamCredentialEntitlementInTx(tx, {
            resourceId: resource.id,
            accountId: activation.creatorAccountId,
        });
        if (!entitlement.ok || !entitlement.mayBroker) {
            return { ok: true, request: activation.request, credentialSelectionBinding: activation.credentialSelectionBinding, readiness: { kind: "policy_denied" } };
        }
        const source = readTeamCredentialSourceBinding(resource.sourceBindingJson);
        if (!source.success && source.reason === 'invalid_json') return { ok: true, request: activation.request, credentialSelectionBinding: activation.credentialSelectionBinding, readiness: { kind: "resource_unavailable" } };
        const sourceResolution = await resolveTeamCredentialResourceSourceInTx(tx, {
            custodianAccountId: resource.custodianAccountId,
            source: source.success ? source.data : null,
        });
        if (sourceResolution.status !== "current") return { ok: true, request: activation.request, credentialSelectionBinding: activation.credentialSelectionBinding, readiness: { kind: "source_unavailable" } };
        const authenticationReadiness = projectSourceAuthenticationReadiness(sourceResolution);
        if (authenticationReadiness) return { ok: true, request: activation.request, credentialSelectionBinding: activation.credentialSelectionBinding, readiness: authenticationReadiness };
        const eligibleBroker = await readEligibleBrokerMachineInTx(tx, {
            custodianAccountId: input.custodianAccountId,
            brokerMachineId: activation.brokerMachineId,
        });
        if (!eligibleBroker.ok) return {
            ok: true,
            request: activation.request,
            credentialSelectionBinding: activation.credentialSelectionBinding,
            readiness: { kind: eligibleBroker.error },
        };
        const { machine } = eligibleBroker;
        const endpoint = readMachineIrohEndpointAuthorityV1({
            capabilities: machine.operationProtocolCapabilities,
            revision: machine.operationProtocolCapabilitiesRevision,
        });
        if (!endpoint || endpoint.endpointId !== activation.request.target.endpointId) {
            return { ok: true, request: activation.request, credentialSelectionBinding: activation.credentialSelectionBinding, readiness: { kind: "broker_unavailable" } };
        }
        return { ok: true, request: activation.request, credentialSelectionBinding: activation.credentialSelectionBinding, readiness: { kind: "available" } };
    }, { isolationLevel: "Serializable" /* Runner readiness captures machine, source, resource and current entitlement together. */ });
}
