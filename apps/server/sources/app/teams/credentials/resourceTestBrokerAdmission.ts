import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { verifyPeerTcpTunnelRelayAuthorizationV2 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/authorization';
import { type PeerTcpTunnelRelayAuthorizationTrustRootV1 } from '@happier-dev/protocol/machines/peer/mediation/tunnel/authorizationSchemas';
import { TeamCredentialResourceTestAdmissionResponseV1Schema, TeamCredentialResourceTestAdmissionV1Schema, type TeamCredentialResourceTestAdmissionResponseV1 } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import { readTeamCredentialSourceBinding } from './sourceBindingRead';

import type { Tx } from '@/storage/inTx';
import { acquireAccountChangePublicationLocksInTx } from '@/app/changes/markAccountChanged';
import { admitTeamCredentialBrokerMachineForResourceInTx } from './brokerPlacementResolver';
import { resolveTeamCredentialResourceSourceInTx } from './resourceSourceResolver';
import { admitTeamCredentialUsageInTx } from './teamCredentialUsageAdmission';
import { authorizeTeamCredentialResourceTestActorInTx } from './resourceTest';

type FailureCode = Extract<TeamCredentialResourceTestAdmissionResponseV1, { ok: false }>['reasonCode'];
type ResourceTestFailure = Extract<TeamCredentialResourceTestAdmissionResponseV1, { ok: false }>;
const failure = (
    reasonCode: FailureCode,
    usageLimit?: ResourceTestFailure['usageLimit'],
): ResourceTestFailure => ({ ok: false, reasonCode, ...(usageLimit ? { usageLimit } : {}) });

function routeMatchesApplicationProtocol(routeKind: string, protocol: string): boolean {
    if (routeKind === 'openai_responses') return protocol === 'openai-responses';
    if (routeKind === 'openai_chat_completions') return protocol === 'openai-chat';
    return routeKind === 'anthropic_messages' && protocol === 'anthropic';
}

/**
 * Revalidates one signed, user-invoked resource test at the Home immediately
 * before upstream work. The test is a real brokered request, so generation is
 * admitted and counted exactly once without manufacturing a Session or API key.
 */
export async function admitTeamCredentialResourceTestRequestInTx(
    tx: Tx,
    input: Readonly<{
        authenticatedBrokerAccountId: string;
        request: unknown;
        observedAt: Date;
        relayAuthorizationTrustRoots: readonly PeerTcpTunnelRelayAuthorizationTrustRootV1[];
    }>,
): Promise<TeamCredentialResourceTestAdmissionResponseV1> {
    const parsed = TeamCredentialResourceTestAdmissionV1Schema.safeParse(input.request);
    if (!parsed.success || parsed.data.binding.kind !== 'resource_test') return failure('invalid_request');
    const { binding, brokerMachineId, relayAuthorization, requestFacts } = parsed.data;
    await acquireAccountChangePublicationLocksInTx(tx, [input.authenticatedBrokerAccountId, binding.actorAccountId],
        { includeSingleAccount: true, intent: 'serializing' });
    const relay = verifyPeerTcpTunnelRelayAuthorizationV2({
        authorization: relayAuthorization,
        nowMs: input.observedAt.getTime(),
        trustRoots: input.relayAuthorizationTrustRoots,
    });
    if (!relay.valid
        || relay.payload.accountId !== input.authenticatedBrokerAccountId
        || relay.payload.targetMachineId !== brokerMachineId
        || relay.payload.flowKind !== 'provider_broker'
        || relay.payload.routeKind !== 'server_relay'
        || relay.payload.providerBroker === undefined
        || !pluginJsonValuesEqual(relay.payload.providerBroker, binding)) {
        return failure('invalid_request');
    }
    if (!requestFacts.generation
        || !routeMatchesApplicationProtocol(requestFacts.routeKind, binding.application.protocol)) {
        return failure('invalid_request');
    }
    const resource = await tx.teamCredentialResource.findUnique({
        where: { id: binding.resourceId },
        select: {
            id: true,
            teamId: true,
            custodianAccountId: true,
            revision: true,
            enabled: true,
            brokerMachineId: true,
            brokerPoolId: true,
            sourceBindingJson: true,
        },
    });
    if (!resource || resource.teamId !== binding.teamId) return failure('resource_unavailable');
    if (resource.revision !== binding.expectedResourceRevision) return failure('resource_changed');
    if (!resource.enabled || resource.custodianAccountId !== input.authenticatedBrokerAccountId) {
        return failure('resource_forbidden');
    }

    const actorAuthorization = await authorizeTeamCredentialResourceTestActorInTx(tx, {
        teamId: resource.teamId,
        actorAccountId: binding.actorAccountId,
        custodianAccountId: resource.custodianAccountId,
        authentication: {
            authenticationAuthority: 'account_automation',
            authenticationEvidence: binding.verifiedCredentialEvidence?.evidence,
        },
    });
    if (!actorAuthorization.ok) return failure(
        actorAuthorization.error === 'not_found_or_not_visible'
            ? 'operation_not_current'
            : 'resource_forbidden',
    );

    // The relay authorization already pins this exact target: the Home selected
    // it for this test before minting the authorization, so Pool membership
    // governs only future selections (11.03 §B3).
    const broker = await admitTeamCredentialBrokerMachineForResourceInTx(tx, {
        resource,
        brokerMachineId,
        selection: 'established',
    });
    if (!broker.ok) return failure(broker.error === 'update_required' ? 'broker_unavailable' : broker.error);
    const source = readTeamCredentialSourceBinding(resource.sourceBindingJson);
    if (!source.success || !pluginJsonValuesEqual(source.data, binding.source)) return failure('resource_unavailable');
    const current = await resolveTeamCredentialResourceSourceInTx(tx, {
        custodianAccountId: resource.custodianAccountId,
        source: source.data,
    });
    if (current.status !== 'current') return failure('resource_unavailable');
    if (current.authenticationFailure) return failure(current.authenticationFailure);

    const usage = await admitTeamCredentialUsageInTx(tx, {
        storageAccountId: binding.actorAccountId,
        sessionId: null,
        turnId: null,
        observedAt: input.observedAt,
        requestId: `resource-test:${binding.requestId}`,
        modelId: requestFacts.modelId,
        usageRoute: 'resource_test',
        authority: {
            kind: 'teamCredentialAdmission',
            requestingAccountId: binding.actorAccountId,
            resourceId: resource.id,
            externalApiKeyId: null,
            sourceCredentialId: current.usageSourceMemberKey,
            workerMachineId: null,
            brokerMachineId,
            deliveryMode: 'brokered',
            executionRunId: null,
        },
    });
    if (!usage.ok) return failure(
        usage.reasonCode,
        usage.reasonCode === 'team_credential_usage_limit' ? usage.usageLimit : undefined,
    );
    if (!usage.created) return failure('duplicate_request');
    return TeamCredentialResourceTestAdmissionResponseV1Schema.parse({
        ok: true,
        resourceId: resource.id,
        resourceRevision: resource.revision,
        brokerMachineId,
        source: source.data,
        operation: { kind: 'resource_test', actorAccountId: binding.actorAccountId },
        usageEventId: usage.usageEventId,
    });
}
