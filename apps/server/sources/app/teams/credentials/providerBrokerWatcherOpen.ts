import { createHash } from 'node:crypto';

import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { resolvePluginActionConnectedAccountUseRequestsV2 } from '@happier-dev/protocol/plugins/manifest/v2';
import {
    GITHUB_BROKER_WATCHER_V1,
    PROVIDER_BROKER_ROUTE_AUDIENCE_V1,
    type ProviderBrokerWatcherOpenRequestV1,
    type ProviderBrokerWatcherOpenResponseV1,
    type ProviderBrokerWatcherRefreshRequestV1,
    type ProviderBrokerWatcherRefreshResponseV1,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';

import {
    assertCurrentAutomationEventCallerMaterializationTx,
    AutomationEventCurrentnessError,
    resolveCurrentAutomationEventManifestTx,
} from '@/app/automations/automationEventCurrentness';
import { isActiveAutomationEventWatcherDefinitionTx } from '@/app/automations/automationEventStoredDefinitionService';
import { classifyMachineDaemonPresence } from '@/app/machines/machineDaemonPresence';
import { signProviderBrokerRouteGrantV1, verifyProviderBrokerRouteGrantSignatureV1 } from '@/app/machines/peer/mediation/signProviderBrokerRouteGrantV1';
import { admitProviderBrokerTopology, readProviderBrokerInitiatorEndpointInTx } from '@/app/providers/brokerConsumerAdmission';
import { reportBrokerAdmissionFailure } from '@/app/providers/brokerRefusalDiagnostic';
import { inTx, type Tx } from '@/storage/inTx';

import { brokerFailureForBindingRejection } from './brokerBindingFailure';
import { readTeamCredentialBrokerPlacement, readTeamCredentialBrokerPresenceDemand, resolveTeamCredentialBrokerPlacementInTx } from './brokerPlacementResolver';
import type { TeamCredentialPoolSourceEligibilityReader } from './poolSourceEligibility';
import { PROVIDER_BROKER_ROUTE_GRANT_TTL_MS, type TeamCredentialProviderBrokerOpenInput } from './providerBrokerAdmission';
import { admitTeamCredentialOperationBindingInTx } from './sessionBinding';

type WatcherAdmissionInput = Pick<TeamCredentialProviderBrokerOpenInput,
    'actorAccountId' | 'nowMs' | 'grantId' | 'signingKey'> & Readonly<{
    publisherInstallationId: string;
    serverIdentityId: string;
    signal: AbortSignal;
}>;
type WatcherOpenInput = WatcherAdmissionInput & Pick<TeamCredentialProviderBrokerOpenInput,
    'authentication' | 'readCurrentPresence'> & Readonly<{
    request: ProviderBrokerWatcherOpenRequestV1;
    readPoolSourceEligibility: TeamCredentialPoolSourceEligibilityReader;
}>;
type WatcherRefreshInput = WatcherAdmissionInput & Readonly<{
    request: ProviderBrokerWatcherRefreshRequestV1;
    signingCapability: Parameters<typeof verifyProviderBrokerRouteGrantSignatureV1>[0]['signingCapability'];
}>;

const forbidden = { ok: false, reasonCode: 'resource_forbidden' } as const;

function watcherActivationBinding(
    input: WatcherAdmissionInput,
    request: Pick<ProviderBrokerWatcherRefreshRequestV1, 'activation' | 'caller'>,
): string {
    return createHash('sha256').update(createCanonicalJsonSigningInput({
        activation: request.activation,
        caller: request.caller,
        publisherInstallationId: input.publisherInstallationId,
    })).digest('hex');
}

async function readCurrentWatcherActivationTx(
    tx: Tx,
    input: WatcherAdmissionInput,
    request: ProviderBrokerWatcherOpenRequestV1,
) {
    const caller = {
        pluginId: request.caller.pluginId,
        machineId: request.initiatorMachineId,
        machineInstallationId: input.publisherInstallationId,
        materializationId: request.caller.materialization.materializationId,
        sourceCustody: request.caller.sourceCustody,
    };
    const accountId = input.actorAccountId;
    const current = await assertCurrentAutomationEventCallerMaterializationTx({
        tx, accountId, serverIdentityId: input.serverIdentityId, caller,
    });
    if (request.activation && !await isActiveAutomationEventWatcherDefinitionTx({
        tx, accountId, caller, callerVersion: current.version, selector: request.activation,
    })) return null;
    return { caller, version: current.version };
}

/** Re-sign the admitted binding while its exact Event assignment remains active. */
export async function refreshTeamCredentialWatcherBroker(input: WatcherRefreshInput): Promise<ProviderBrokerWatcherRefreshResponseV1> {
    const { request, actorAccountId, nowMs, signal, signingCapability } = input;
    const previous = request.refreshAuthority;
    const payload = previous.payload;
    if (payload.resourceId !== request.resourceId
        || payload.initiator.accountId !== actorAccountId
        || payload.initiator.machineId !== request.initiatorMachineId
        || payload.consumer.occurrenceId !== request.caller.occurrenceId
        || payload.activationBinding !== watcherActivationBinding(input, request)
        || !verifyProviderBrokerRouteGrantSignatureV1({ authority: previous, signingCapability, nowMs })) return forbidden;

    signal.throwIfAborted();
    const current = await inTx(tx => readCurrentWatcherActivationTx(tx, input, request), {
        isolationLevel: 'Serializable',
    }).catch(error => {
        if (error instanceof AutomationEventCurrentnessError) return null;
        throw error;
    });
    if (!current) return forbidden;
    signal.throwIfAborted();
    return {
        ok: true,
        authority: signProviderBrokerRouteGrantV1({ signingKey: input.signingKey, payload: {
            ...payload, grantId: input.grantId, issuedAt: nowMs, expiresAt: nowMs + PROVIDER_BROKER_ROUTE_GRANT_TTL_MS,
        } }),
    };
}

/** Admit the current watcher and its Team binding once, then resolve the transport for that snapshot. */
export async function openTeamCredentialWatcherBroker(input: WatcherOpenInput): Promise<ProviderBrokerWatcherOpenResponseV1> {
    const { request, actorAccountId, signal } = input;
    const { service, backgroundServiceId, attemptActionId, purposeId } = GITHUB_BROKER_WATCHER_V1;
    if (request.caller.pluginId !== service.pluginId || request.caller.contributionLocalId !== backgroundServiceId) return forbidden;

    signal.throwIfAborted();
    const admitted = await inTx(async tx => {
        const current = await readCurrentWatcherActivationTx(tx, input, request);
        if (!current) return forbidden;
        const { caller } = current;
        const manifest = await resolveCurrentAutomationEventManifestTx({
            tx, accountId: actorAccountId, pluginId: caller.pluginId, version: current.version,
            machineId: caller.machineId, machineInstallationId: caller.machineInstallationId,
        });
        const purposeRequest = resolvePluginActionConnectedAccountUseRequestsV2(manifest, attemptActionId)
            ?.find(candidate => candidate.request.id === purposeId)?.request;
        const attempt = manifest.contributes.actions.find(action => action.id === attemptActionId);
        if (!purposeRequest || !attempt?.connectedAccountPurposeBindings?.some(binding => binding.purpose === purposeRequest.id)
            || !purposeRequest.scope.serviceRefs.some(reference => typeof reference === 'string'
                ? reference === service.localId
                : reference.pluginId === service.pluginId && reference.localId === service.localId)) return forbidden;
        const purpose = { consumer: { pluginId: caller.pluginId, localId: attemptActionId }, purpose: purposeRequest.id };
        const binding = await admitTeamCredentialOperationBindingInTx(tx, {
            consumer: { kind: 'platform_operation', resourceId: request.resourceId },
            accountId: actorAccountId,
            slot: { kind: 'connected_service_purpose', purpose },
            deliveryMode: 'brokered', authentication: input.authentication,
        });
        if (!binding.ok) return reportableBindingFailure(binding.reason);
        const source = binding.sourceBinding;
        if (source.kind === 'provider_connection') return forbidden;
        const sourceService = source.kind === 'connected_account' ? source.target.account.service : source.target.service;
        if (sourceService.pluginId !== service.pluginId || sourceService.localId !== service.localId) return forbidden;

        const resource = await tx.teamCredentialResource.findUnique({ where: { id: request.resourceId },
            select: { id: true, custodianAccountId: true, brokerMachineId: true, brokerPoolId: true } });
        if (!resource || resource.custodianAccountId === actorAccountId) return forbidden;
        const initiator = await readProviderBrokerInitiatorEndpointInTx(tx, {
            accountId: actorAccountId, machineId: request.initiatorMachineId, sessionId: null,
        });
        if (!initiator) return { ok: false as const, reasonCode: 'broker_unavailable' as const, refusalReason: 'initiator_endpoint_unavailable' };
        return { ok: true as const, binding: binding.binding, resource, source, purpose, initiator };
    }, { isolationLevel: 'Serializable' }).catch(error => {
        if (error instanceof AutomationEventCurrentnessError) return forbidden;
        throw error;
    });
    if (!admitted.ok) return reportBrokerAdmissionFailure('open', admitted);

    const { binding, resource, initiator, purpose, source } = admitted;
    const brokerMachineIds = await readTeamCredentialBrokerPresenceDemand({ resource });
    const presence = await input.readCurrentPresence({
        initiatorAccountId: actorAccountId, initiatorMachineId: request.initiatorMachineId,
        brokerAccountId: resource.custodianAccountId, brokerMachineIds,
    });
    signal.throwIfAborted();
    const initiatorPresence = classifyMachineDaemonPresence(presence.initiatorPresence, request.initiatorMachineId);
    if (initiatorPresence !== 'connected') return reportBrokerAdmissionFailure('open', {
        ok: false, reasonCode: 'broker_unavailable',
        refusalReason: initiatorPresence === 'unknown' ? 'initiator_presence_unavailable' : 'initiator_offline',
    });

    let poolEligibleMachineIds: ReadonlySet<string> | undefined;
    const location = readTeamCredentialBrokerPlacement(resource);
    if (location.ok && location.placement?.kind === 'machine_pool') {
        const eligibility = await input.readPoolSourceEligibility({
            custodianAccountId: resource.custodianAccountId, machineIds: brokerMachineIds, teamId: binding.teamId,
            resourceId: resource.id, resourceRevision: binding.resourceRevision, source, scope: 'action_purpose', purpose,
            signal,
        }).catch(() => null);
        signal.throwIfAborted();
        if (!eligibility) return reportBrokerAdmissionFailure('open', {
            ok: false, reasonCode: 'broker_unavailable', refusalReason: 'pool_source_read_unavailable',
        });
        if (eligibility.eligibleMachineIds.size === 0 && [...eligibility.reasons.values()]
            .includes(CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired)) {
            return { ok: false, reasonCode: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired };
        }
        poolEligibleMachineIds = eligibility.eligibleMachineIds;
    }

    const initiatorAddress = { machineId: request.initiatorMachineId, endpointId: initiator.endpointId };
    const placement = await inTx(tx => resolveTeamCredentialBrokerPlacementInTx(tx, {
        resource, presence: presence.brokerPresence, requestKey: request.caller.occurrenceId,
        poolInitiator: initiatorAddress, requiredProtocolVersion: 1, poolEligibleMachineIds,
    }));
    signal.throwIfAborted();
    if (!placement.ok) return reportBrokerAdmissionFailure('open', {
        ok: false, reasonCode: placement.error,
        ...('refusalReason' in placement ? { refusalReason: placement.refusalReason } : {}),
    });
    const broker = placement.broker;
    const endpoint = broker?.endpointAuthority;
    if (!broker || !endpoint) return reportBrokerAdmissionFailure('open', {
        ok: false, reasonCode: 'broker_unavailable', refusalReason: 'target_endpoint_unavailable',
    });
    const targetAddress = { machineId: broker.machineId, endpointId: endpoint.endpointId };
    const topology = admitProviderBrokerTopology(initiatorAddress, targetAddress);
    if (!topology.ok) return topology;
    const activation = request.activation;
    const authority = signProviderBrokerRouteGrantV1({ signingKey: input.signingKey, payload: {
        v: 1, scope: request.scope, aud: PROVIDER_BROKER_ROUTE_AUDIENCE_V1, grantId: input.grantId,
        issuedAt: input.nowMs, expiresAt: input.nowMs + PROVIDER_BROKER_ROUTE_GRANT_TTL_MS,
        teamId: binding.teamId, resourceId: resource.id, resourceRevision: binding.resourceRevision, source,
        consumer: { occurrenceId: request.caller.occurrenceId, purpose },
        ...(activation ? { activationBinding: watcherActivationBinding(input, { activation, caller: request.caller }) } : {}),
        initiator: { accountId: actorAccountId, ...initiatorAddress },
        target: { custodianAccountId: resource.custodianAccountId, ...targetAddress },
    } });
    return {
        ok: true,
        authority,
        target: {
            custodianAccountId: resource.custodianAccountId, brokerMachineId: broker.machineId,
            endpointId: endpoint.endpointId, endpointRevision: endpoint.revision,
            endpoint: { endpointId: endpoint.endpointId,
                ...(endpoint.relayUrls ? { relayUrls: [...endpoint.relayUrls] } : {}),
                ...(endpoint.directAddresses ? { directAddresses: [...endpoint.directAddresses] } : {}) },
        },
    };
}

function reportableBindingFailure(reason: Parameters<typeof brokerFailureForBindingRejection>[0]) {
    // A publisher who cannot use a resource must get the same answer for an unknown id.
    if (reason === 'resource_missing') return forbidden;
    return { ok: false as const, reasonCode: brokerFailureForBindingRejection(reason), refusalReason: reason };
}
