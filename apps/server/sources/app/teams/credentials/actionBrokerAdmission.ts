import { createHash } from 'node:crypto';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { fetchRepeatKey, saveRepeatKey, deleteRepeatKeyExact } from '@/storage/queue/repeatKey';
import type { TeamCredentialSourceBindingV1 } from '@happier-dev/protocol/teams/credentials/sourceBindingV1';
import { CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import type { TeamCredentialPoolSourceEligibilityReader } from './poolSourceEligibility';
import { readTeamCredentialSourceBinding } from './sourceBindingRead';
import { brokerFailureForBindingRejection } from './brokerBindingFailure';
import {
    PROVIDER_BROKER_ACTION_ROUTE_AUDIENCE_V3,
    ProviderBrokerActionOpenRequestV3Schema,
    ProviderBrokerActionAdmissionV3Schema,
    type ProviderBrokerActionOpenRequestV3,
    type ProviderBrokerActionOpenResponseV3,
    type ProviderBrokerActionAdmissionResponseV3,
    type SignedProviderBrokerActionRouteGrantV3,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { inTx } from '@/storage/inTx';
import { db } from '@/storage/db';
import { acquireAccountChangePublicationLocksInTx } from '@/app/changes/markAccountChanged';
import type { SessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication';
import { classifyMachineDaemonPresence, type MachineDaemonPresenceInventory } from '@/app/machines/machineDaemonPresence';
import { readProviderBrokerInitiatorEndpointInTx, admitProviderBrokerTopology } from '@/app/providers/brokerConsumerAdmission';
import { signProviderBrokerActionRouteGrantV3 } from '@/app/machines/peer/mediation/signProviderBrokerRouteGrantV1';
import { admitTeamCredentialOperationBindingInTx } from './sessionBinding';
import { admitTeamCredentialActionDeclarationInTx, readTeamCredentialActionDeclaration } from './actionDeclarationAdmission';
import { readTeamCredentialBrokerPresenceDemand, resolveTeamCredentialBrokerPlacementInTx, readTeamCredentialBrokerPlacement, resolveTeamCredentialBrokerPlacementFingerprint } from './brokerPlacementResolver';

export type TeamCredentialActionBrokerOpenInput = Readonly<{
    actorAccountId: string;
    rootActionId: string;
    admittedReviewedChildActionId?: string;
    authentication: SessionAccessAuthentication;
    request: ProviderBrokerActionOpenRequestV3;
    readCurrentPresence(input: Readonly<{ initiatorAccountId: string; initiatorMachineId: string;
        brokerAccountId: string; brokerMachineIds: readonly string[] }>): Promise<Readonly<{
            initiatorPresence: MachineDaemonPresenceInventory; brokerPresence: MachineDaemonPresenceInventory }>>;
    readPoolSourceEligibility?: TeamCredentialPoolSourceEligibilityReader;
    nowMs: number;
    grantId: string;
    signingKey: Readonly<{ keyId: string; secretKey: Uint8Array }>;
    signal?: AbortSignal;
}>;

/** One root may invoke several declared roles/purposes. The key identifies
 * that credential use; its value identifies the issued signed admission. */
function finiteActionAdmissionKey(input: Readonly<{
    accountId: string;
    resourceId: string;
    consumer: ProviderBrokerActionOpenRequestV3['consumer'];
}>): string {
    return `team-credential-action:${createHash('sha256').update(createCanonicalJsonSigningInput(input)).digest('hex')}`;
}

/** Finite Actions share the Team operation admission owner. Presence prepares
 * transport only; the one locked admission qualifies Team, source and declared
 * purpose before signing an immutable finite-job authority. */
export async function openTeamCredentialActionBroker(input: TeamCredentialActionBrokerOpenInput): Promise<ProviderBrokerActionOpenResponseV3> {
    const parsed = ProviderBrokerActionOpenRequestV3Schema.safeParse(input.request);
    if (!parsed.success) return { ok: false, reasonCode: 'invalid_request' };
    const request = parsed.data;
    input.signal?.throwIfAborted();
    const hint = await db.teamCredentialResource.findUnique({ where: { id: request.resourceId },
        select: { id: true, teamId: true, revision: true, sourceBindingJson: true, custodianAccountId: true, brokerMachineId: true, brokerPoolId: true } });
    if (!hint) return { ok: false, reasonCode: 'resource_forbidden' };
    const brokerMachineIds = await readTeamCredentialBrokerPresenceDemand({ resource: hint });
    const presence = await input.readCurrentPresence({ initiatorAccountId: input.actorAccountId,
        initiatorMachineId: request.initiatorMachineId, brokerAccountId: hint.custodianAccountId, brokerMachineIds });
    let poolEligibility: (Awaited<ReturnType<TeamCredentialPoolSourceEligibilityReader>>
        & Readonly<{ source: TeamCredentialSourceBindingV1 }>) | null = null;
    const hintedPlacement = readTeamCredentialBrokerPlacement(hint);
    if (!hintedPlacement.ok) return { ok: false, reasonCode: 'resource_unavailable' };
    if (hintedPlacement.placement?.kind === 'machine_pool') {
        const source = readTeamCredentialSourceBinding(hint.sourceBindingJson);
        if (!source.success) return { ok: false, reasonCode: 'resource_unavailable' };
        if (!input.readPoolSourceEligibility) return { ok: false, reasonCode: 'broker_unavailable' };
        const signal = input.signal ?? new AbortController().signal;
        const eligibility = await input.readPoolSourceEligibility({ custodianAccountId: hint.custodianAccountId,
            machineIds: brokerMachineIds, teamId: hint.teamId, resourceId: hint.id, resourceRevision: hint.revision,
            source: source.data, scope: 'action_purpose', purpose: request.consumer.purpose, signal }).catch(() => null);
        signal.throwIfAborted();
        if (!eligibility) return { ok: false, reasonCode: 'broker_unavailable' };
        poolEligibility = { ...eligibility, source: source.data };
        if (poolEligibility.eligibleMachineIds.size === 0 && [...poolEligibility.reasons.values()]
            .includes(CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired)) {
            return { ok: false, reasonCode: CONNECTED_SERVICE_UX_DIAGNOSTIC_CODES.connectedServiceCredentialReconnectRequired };
        }
    }
    const preparedDeclaration = await readTeamCredentialActionDeclaration({ accountId: input.actorAccountId,
        machineId: request.initiatorMachineId, consumer: request.consumer });
    input.signal?.throwIfAborted();
    return await inTx(async tx => {
        await acquireAccountChangePublicationLocksInTx(tx, [input.actorAccountId, hint.custodianAccountId],
            { includeSingleAccount: true, intent: 'serializing' });
        input.signal?.throwIfAborted();
        const admitted = await admitTeamCredentialOperationBindingInTx(tx, {
            consumer: { kind: 'action_operation', resourceId: request.resourceId }, accountId: input.actorAccountId,
            slot: { kind: 'connected_service_purpose', purpose: request.consumer.purpose },
            deliveryMode: 'brokered', authentication: input.authentication,
        });
        if (!admitted.ok) return { ok: false as const, reasonCode: brokerFailureForBindingRejection(admitted.reason) };
        const resource = await tx.teamCredentialResource.findUnique({ where: { id: request.resourceId },
            select: { id: true, teamId: true, custodianAccountId: true, brokerMachineId: true, brokerPoolId: true } });
        if (!resource || resource.custodianAccountId !== hint.custodianAccountId
            || resource.custodianAccountId === input.actorAccountId) return { ok: false as const, reasonCode: 'resource_unavailable' as const };
        // Source availability was observed outside the transaction. Consume
        // that observation only for the same source and placement admitted here.
        if (poolEligibility && (!pluginJsonValuesEqual(admitted.sourceBinding, poolEligibility.source)
            || resolveTeamCredentialBrokerPlacementFingerprint(resource) !== resolveTeamCredentialBrokerPlacementFingerprint(hint))) {
            return { ok: false as const, reasonCode: 'resource_changed' as const };
        }
        const declaration = await admitTeamCredentialActionDeclarationInTx(tx, {
            accountId: input.actorAccountId, machineId: request.initiatorMachineId, rootActionId: input.rootActionId,
            pluginVersion: request.consumer.pluginVersion, consumer: request.consumer, source: admitted.sourceBinding,
            preparedDeclaration,
            ...(input.admittedReviewedChildActionId ? { admittedReviewedChildActionId: input.admittedReviewedChildActionId } : {}),
        });
        if (!declaration.ok) return { ok: false as const, reasonCode: 'resource_forbidden' as const };
        const initiator = await readProviderBrokerInitiatorEndpointInTx(tx, {
            accountId: input.actorAccountId, machineId: request.initiatorMachineId, sessionId: null });
        if (!initiator || classifyMachineDaemonPresence(presence.initiatorPresence, request.initiatorMachineId) !== 'connected') {
            return { ok: false as const, reasonCode: 'broker_unavailable' as const };
        }
        const placement = await resolveTeamCredentialBrokerPlacementInTx(tx, { resource,
            presence: presence.brokerPresence, requestKey: request.consumer.operationId,
            poolInitiator: { machineId: request.initiatorMachineId, endpointId: initiator.endpointId },
            requiredProtocolVersion: 3,
            ...(poolEligibility ? { poolEligibleMachineIds: poolEligibility.eligibleMachineIds } : {}),
        });
        if (!placement.ok) return { ok: false as const, reasonCode: placement.error };
        const broker = placement.broker;
        const endpoint = broker?.endpointAuthority;
        if (!broker || !endpoint) return { ok: false as const, reasonCode: 'broker_unavailable' as const };
        const topology = admitProviderBrokerTopology({ machineId: request.initiatorMachineId, endpointId: initiator.endpointId },
            { machineId: broker.machineId, endpointId: endpoint.endpointId });
        if (!topology.ok) return topology;
        const admissionKey = finiteActionAdmissionKey({ accountId: input.actorAccountId,
            resourceId: resource.id, consumer: request.consumer });
        // Opens already hold the Account publication lock. A live admission
        // cannot be replaced before the carrier consumes it.
        if (await fetchRepeatKey(tx, admissionKey, new Date(input.nowMs)) !== null) {
            return { ok: false as const, reasonCode: 'operation_not_current' as const };
        }
        const authority = signProviderBrokerActionRouteGrantV3({ signingKey: input.signingKey, payload: {
            v: 3, grantId: input.grantId, aud: PROVIDER_BROKER_ACTION_ROUTE_AUDIENCE_V3,
            issuedAt: input.nowMs, expiresAt: input.nowMs + DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel,
            teamId: resource.teamId, resourceId: resource.id, source: admitted.sourceBinding,
            consumer: request.consumer, inputDigest: request.inputDigest, declaration: declaration.declaration,
            initiator: { accountId: input.actorAccountId, machineId: request.initiatorMachineId, endpointId: initiator.endpointId },
            target: { custodianAccountId: resource.custodianAccountId, machineId: broker.machineId, endpointId: endpoint.endpointId },
        } });
        await saveRepeatKey(tx, admissionKey, input.grantId, new Date(authority.payload.expiresAt));
        return { ok: true as const, authority, target: { custodianAccountId: resource.custodianAccountId,
            brokerMachineId: broker.machineId, endpointId: endpoint.endpointId, endpointRevision: endpoint.revision,
            endpoint: { endpointId: endpoint.endpointId, ...(endpoint.relayUrls ? { relayUrls: [...endpoint.relayUrls] } : {}),
                ...(endpoint.directAddresses ? { directAddresses: [...endpoint.directAddresses] } : {}) } } };
    });
}

/** Consume the admitted job once across carriers. Team entitlement was
 * decided at open; withdrawals apply to the next open, not this execution. */
export async function admitTeamCredentialActionBrokerRequest(input: Readonly<{
    authenticatedBrokerAccountId: string;
    request: unknown;
    verifyAuthority(authority: SignedProviderBrokerActionRouteGrantV3): boolean;
}>): Promise<ProviderBrokerActionAdmissionResponseV3> {
    const parsed = ProviderBrokerActionAdmissionV3Schema.safeParse(input.request);
    if (!parsed.success) return { ok: false, reasonCode: 'invalid_request' };
    const authority = parsed.data.authority;
    const grant = authority.payload;
    if (grant.target.custodianAccountId !== input.authenticatedBrokerAccountId
        || !input.verifyAuthority(authority)) return { ok: false, reasonCode: 'resource_forbidden' };
    const admissionKey = finiteActionAdmissionKey({ accountId: grant.initiator.accountId,
        resourceId: grant.resourceId, consumer: grant.consumer });
    const consumed = await inTx(tx => deleteRepeatKeyExact(tx, admissionKey, grant.grantId));
    return consumed ? { ok: true } : { ok: false, reasonCode: 'operation_not_current' };
}
