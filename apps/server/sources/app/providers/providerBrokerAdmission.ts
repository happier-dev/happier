import {
    ProviderBrokerAccountOpenRequestV2Schema, ProviderBrokerAccountAdmissionV2Schema,
    SignedProviderBrokerRouteGrantV2Schema, createProviderBrokerRouteGrantSigningInputV2,
    PROVIDER_BROKER_ROUTE_AUDIENCE_V2,
    type ProviderBrokerAccountOpenRequestV2, type ProviderBrokerAccountOpenResponseV2,
    type ProviderBrokerAccountAdmissionV2, type ProviderBrokerAccountAdmissionResponseV2,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { readMachineIrohEndpointAuthorityV1, MachineOperationProtocolCapabilitiesV1StoredReadSchema } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { pluginJsonValuesEqual } from '@happier-dev/protocol/plugins/contributions/jsonSchemaValues';
import { auth } from '@/app/auth/auth';
import { reportBrokerAdmissionFailure } from './brokerRefusalDiagnostic';
import { readEligibleBrokerMachineInTx } from '@/app/teams/credentials/brokerMachineEligibility';
import { classifyMachineDaemonPresence, type MachineDaemonPresenceInventory } from '@/app/machines/machineDaemonPresence';
import { inTx, type Tx } from '@/storage/inTx';
import { db } from '@/storage/db';
import { signRouteGrantPayload } from '@/app/machines/peer/mediation/mintDirectRouteGrantV1';
import { acquireProviderBrokerConsumerAdmissionInTx, admitProviderBrokerConsumerInTx, admitProviderBrokerTopology, readProviderBrokerInitiatorEndpointInTx, type ProviderBrokerConsumerCurrentness } from './brokerConsumerAdmission';

type ConsumerResolver = (input: Readonly<{
    executionRunId: string; requestingAccountId: string; workerMachineId: string; expectedOccurrenceId: string | null;
}>) => Promise<(Readonly<{ ok: true }> & ProviderBrokerConsumerCurrentness) | Extract<ProviderBrokerAccountAdmissionResponseV2, { ok: false }>>;
type Common = Readonly<{
    homeId: string;
    actorAccountId: string;
    readCurrentPresence(input: Readonly<{
        initiatorAccountId: string; initiatorMachineId: string; targetAccountId: string; targetMachineId: string;
    }>): Promise<Readonly<{ initiatorPresence: MachineDaemonPresenceInventory; targetPresence: MachineDaemonPresenceInventory }>>;
    resolveExecutionRunCurrentness: ConsumerResolver;
}>;

async function readOwnedTargetInTx(tx: Tx, accountId: string, machineId: string) {
    const eligible = await readEligibleBrokerMachineInTx(tx, { custodianAccountId: accountId, brokerMachineId: machineId });
    if (!eligible.ok) return eligible;
    const { machine } = eligible;
    const endpoint = readMachineIrohEndpointAuthorityV1({ capabilities: machine.operationProtocolCapabilities,
        revision: machine.operationProtocolCapabilitiesRevision });
    return endpoint ? { ok: true, machine, endpoint } as const
        : { ok: false, error: 'broker_unavailable', refusalReason: 'target_endpoint_unavailable' } as const;
}

function supportsAccountConnectionIngress(capabilities: unknown): boolean {
    const parsed = MachineOperationProtocolCapabilitiesV1StoredReadSchema.safeParse(capabilities);
    return parsed.success && parsed.data.providerBrokerIngress?.protocolVersions.some(version => version === 2) === true;
}

type MachineAdmissionInput = Common & Readonly<{
    initiatorMachineId: string;
    targetMachineId: string;
    consumer: ProviderBrokerAccountOpenRequestV2['consumer'];
    tokenEpoch: number | undefined;
    expectedOccurrenceId: string | null;
}>;

async function authorizeMachinesInTx(tx: Tx, input: MachineAdmissionInput, executionRun: ProviderBrokerConsumerCurrentness | null) {
    if (!await auth.isSignedCredentialCurrent(tx, input.actorAccountId, input.tokenEpoch)) {
        return { ok: false, reasonCode: 'operation_not_current' } as const;
    }
    const admitted = await admitProviderBrokerConsumerInTx(tx, { accountId: input.actorAccountId,
        initiatorMachineId: input.initiatorMachineId, consumer: input.consumer, executionRun });
    if (!admitted.ok) return admitted;
    const sessionId = input.consumer.kind === 'session' ? input.consumer.sessionId : executionRun?.parentSessionId ?? null;
    const [initiator, target] = await Promise.all([
        readProviderBrokerInitiatorEndpointInTx(tx, { accountId: input.actorAccountId,
            machineId: input.initiatorMachineId, sessionId }),
        readOwnedTargetInTx(tx, input.actorAccountId, input.targetMachineId),
    ]);
    if (!initiator) return brokerUnavailable('initiator_endpoint_unavailable');
    if (!target.ok) return 'refusalReason' in target
        ? brokerUnavailable(target.refusalReason)
        : { ok: false, reasonCode: target.error } as const;
    const topology = admitProviderBrokerTopology(
        { machineId: input.initiatorMachineId, endpointId: initiator.endpointId },
        { machineId: input.targetMachineId, endpointId: target.endpoint.endpointId },
    );
    if (!topology.ok) return topology;
    if (!supportsAccountConnectionIngress(target.machine.operationProtocolCapabilities)) {
        return { ok: false, reasonCode: 'update_required' } as const;
    }
    return { ok: true, initiator, target, executionRunOccurrenceId: admitted.executionRunOccurrenceId } as const;
}

function brokerUnavailable(refusalReason: string) {
    return { ok: false, reasonCode: 'broker_unavailable', refusalReason } as const;
}

type AccountBrokerFailure = Extract<ProviderBrokerAccountAdmissionResponseV2, { ok: false }>
    & Readonly<{ refusalReason?: string }>;

/** Prepare transport identities without admitting work. Presence belongs to the
 * actual Machine custodian; the signed requester and private catalog hub remain
 * the requesting Account. Admit once after discovery, and produce the terminal
 * result while that transaction still holds its admission fence. */
async function withCurrentMachines<T extends Readonly<{ ok: true }>>(
    input: MachineAdmissionInput,
    finalize: (current: Extract<Awaited<ReturnType<typeof authorizeMachinesInTx>>, { ok: true }>) => T | AccountBrokerFailure,
) {
    const resolveRun = async (expectedOccurrenceId: string | null) => input.consumer.kind === 'execution_run'
        ? await input.resolveExecutionRunCurrentness({ executionRunId: input.consumer.executionRunId,
            requestingAccountId: input.actorAccountId, workerMachineId: input.initiatorMachineId, expectedOccurrenceId })
        : null;
    const [initiator, target] = await Promise.all([
        db.machine.findUnique({ where: { id: input.initiatorMachineId }, select: {
            accountId: true, operationProtocolCapabilities: true, operationProtocolCapabilitiesRevision: true,
        } }),
        db.machine.findFirst({ where: { id: input.targetMachineId, accountId: input.actorAccountId }, select: {
            operationProtocolCapabilities: true, operationProtocolCapabilitiesRevision: true,
        } }),
    ]);
    const initiatorEndpoint = initiator && readMachineIrohEndpointAuthorityV1({
        capabilities: initiator.operationProtocolCapabilities, revision: initiator.operationProtocolCapabilitiesRevision,
    });
    const targetEndpoint = target && readMachineIrohEndpointAuthorityV1({
        capabilities: target.operationProtocolCapabilities, revision: target.operationProtocolCapabilitiesRevision,
    });
    if (!initiator || !initiatorEndpoint) return brokerUnavailable('initiator_endpoint_unavailable');
    if (!targetEndpoint) return brokerUnavailable('target_endpoint_unavailable');
    let presence: Awaited<ReturnType<Common['readCurrentPresence']>>;
    try {
        presence = await input.readCurrentPresence({
            initiatorAccountId: initiator.accountId, initiatorMachineId: input.initiatorMachineId,
            targetAccountId: input.actorAccountId, targetMachineId: input.targetMachineId,
        });
    } catch {
        return brokerUnavailable('presence_read_unavailable');
    }
    const currentRun = await resolveRun(input.expectedOccurrenceId);
    if (currentRun && !currentRun.ok) return currentRun;
    return await inTx(async tx => {
        // The prepared custodian is a cohort hint, never current authority.
        // Recheck it and both Machines after admission, then hold the complete
        // cohort through signing/terminal admission, including foreign custody.
        await acquireProviderBrokerConsumerAdmissionInTx(tx, {
            accountIds: [input.actorAccountId],
            custodianAccountIds: [initiator.accountId],
        });
        const current = await authorizeMachinesInTx(tx, input, currentRun);
        if (!current.ok) return current;
        if (current.initiator.custodianAccountId !== initiator.accountId) return brokerUnavailable('initiator_custody_changed');
        if (current.initiator.endpointId !== initiatorEndpoint.endpointId) return brokerUnavailable('initiator_endpoint_changed');
        if (current.target.endpoint.endpointId !== targetEndpoint.endpointId) return brokerUnavailable('target_endpoint_changed');
        const initiatorPresence = classifyMachineDaemonPresence(presence.initiatorPresence, input.initiatorMachineId);
        if (initiatorPresence !== 'connected') return brokerUnavailable(initiatorPresence === 'unknown'
            ? 'initiator_presence_unavailable' : 'initiator_offline');
        const targetPresence = classifyMachineDaemonPresence(presence.targetPresence, input.targetMachineId);
        if (targetPresence !== 'connected') return brokerUnavailable(targetPresence === 'unknown'
            ? 'target_presence_unavailable' : 'target_offline');
        return finalize(current);
    }, { isolationLevel: 'ReadCommitted' });
}

/** Home admits transport identity and consumer currentness only. An encrypted
 * connection id is never interpreted here as catalog authorization. */
export async function openAccountConnectionProviderBroker(input: Common & Readonly<{
    request: ProviderBrokerAccountOpenRequestV2;
    tokenEpoch: number | undefined;
    nowMs: number;
    grantId: string;
    signingKey: Readonly<{ keyId: string; secretKey: Uint8Array }>;
    verifyRefreshAuthority(authority: ProviderBrokerAccountAdmissionV2['authority']): boolean;
}>): Promise<ProviderBrokerAccountOpenResponseV2> {
    const parsed = ProviderBrokerAccountOpenRequestV2Schema.safeParse(input.request);
    if (!parsed.success) return { ok: false, reasonCode: 'invalid_request' };
    const request = parsed.data;
    const refresh = request.refreshAuthority?.payload;
    if (refresh && (!input.verifyRefreshAuthority(request.refreshAuthority!)
        || refresh.homeId !== input.homeId || refresh.accountId !== input.actorAccountId
        || refresh.initiator.machineId !== request.initiatorMachineId || refresh.target.machineId !== request.targetMachineId
        || refresh.initiatorTokenEpoch !== input.tokenEpoch
        || !pluginJsonValuesEqual(refresh.consumer, request.consumer) || !pluginJsonValuesEqual(refresh.source, request.source)
        || !pluginJsonValuesEqual(refresh.application, request.application))) return { ok: false, reasonCode: 'invalid_request' };
    const result = await withCurrentMachines<Extract<ProviderBrokerAccountOpenResponseV2, { ok: true }>>({ ...input, initiatorMachineId: request.initiatorMachineId,
        targetMachineId: request.targetMachineId, consumer: request.consumer, expectedOccurrenceId: refresh?.executionRunOccurrenceId ?? null }, admitted => {
        const { initiator, target } = admitted;
        if (refresh && refresh.initiator.endpointId !== initiator.endpointId) return brokerUnavailable('initiator_endpoint_changed');
        if (refresh && refresh.target.endpointId !== target.endpoint.endpointId) return brokerUnavailable('target_endpoint_changed');
        const payload = {
            v: 2 as const, grantId: input.grantId, aud: PROVIDER_BROKER_ROUTE_AUDIENCE_V2,
            issuedAt: input.nowMs, expiresAt: input.nowMs + DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel,
            homeId: input.homeId, accountId: input.actorAccountId, source: request.source,
            initiatorTokenEpoch: input.tokenEpoch ?? 0,
            initiator: { accountId: input.actorAccountId, machineId: request.initiatorMachineId, endpointId: initiator.endpointId },
            target: { custodianAccountId: input.actorAccountId, machineId: request.targetMachineId, endpointId: target.endpoint.endpointId },
            consumer: request.consumer, application: request.application,
            ...(admitted.executionRunOccurrenceId ? { executionRunOccurrenceId: admitted.executionRunOccurrenceId } : {}),
        };
        const authority = SignedProviderBrokerRouteGrantV2Schema.parse({ payload, signature: signRouteGrantPayload({
            signingInput: createProviderBrokerRouteGrantSigningInputV2(payload), signingKey: input.signingKey,
        }) });
        return { ok: true, authority, target: {
            custodianAccountId: input.actorAccountId, brokerMachineId: request.targetMachineId,
            endpointId: target.endpoint.endpointId, endpointRevision: target.endpoint.revision,
            endpoint: { endpointId: target.endpoint.endpointId,
                ...(target.endpoint.relayUrls ? { relayUrls: [...target.endpoint.relayUrls] } : {}),
                ...(target.endpoint.directAddresses ? { directAddresses: [...target.endpoint.directAddresses] } : {}),
            },
        } };
    });
    return result.ok ? result : reportBrokerAdmissionFailure('account_open', result);
}

export async function admitAccountConnectionProviderBroker(input: Common & Readonly<{
    request: ProviderBrokerAccountAdmissionV2;
    verifyAuthority(authority: ProviderBrokerAccountAdmissionV2['authority']): boolean;
}>): Promise<ProviderBrokerAccountAdmissionResponseV2> {
    const parsed = ProviderBrokerAccountAdmissionV2Schema.safeParse(input.request);
    if (!parsed.success || !input.verifyAuthority(parsed.data.authority)) return { ok: false, reasonCode: 'invalid_request' };
    const payload = parsed.data.authority.payload;
    if (payload.homeId !== input.homeId || payload.accountId !== input.actorAccountId) return { ok: false, reasonCode: 'resource_forbidden' };
    if (payload.consumer.kind === 'execution_run') {
        // The signed open already admits this exact Run occurrence, source and
        // Machines. Its executor owns cancellation; a later application request
        // checks only the Account credential, without asking the Run to re-admit.
        // Grant expiry bounds new carrier streams, not work already admitted.
        return await inTx(async tx => await auth.isSignedCredentialCurrent(tx, input.actorAccountId, payload.initiatorTokenEpoch)
            ? { ok: true } as const : { ok: false, reasonCode: 'operation_not_current' } as const);
    }
    const result = await withCurrentMachines<Extract<ProviderBrokerAccountAdmissionResponseV2, { ok: true }>>({ ...input, tokenEpoch: payload.initiatorTokenEpoch,
        initiatorMachineId: payload.initiator.machineId, targetMachineId: payload.target.machineId,
        consumer: payload.consumer, expectedOccurrenceId: payload.executionRunOccurrenceId ?? null }, admitted => {
        if (admitted.initiator.endpointId !== payload.initiator.endpointId) return brokerUnavailable('initiator_endpoint_changed');
        if (admitted.target.endpoint.endpointId !== payload.target.endpointId) return brokerUnavailable('target_endpoint_changed');
        return { ok: true };
    });
    return result.ok ? result : reportBrokerAdmissionFailure('account_admit', result);
}
