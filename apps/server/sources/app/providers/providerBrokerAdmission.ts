import {
    ProviderBrokerAccountOpenRequestV2Schema, ProviderBrokerAccountAdmissionV2Schema,
    SignedProviderBrokerRouteGrantV2Schema, createProviderBrokerRouteGrantSigningInputV2,
    PROVIDER_BROKER_ROUTE_AUDIENCE_V2,
    type ProviderBrokerAccountOpenRequestV2, type ProviderBrokerAccountOpenResponseV2,
    type ProviderBrokerAccountAdmissionV2, type ProviderBrokerAccountAdmissionResponseV2,
} from '@happier-dev/protocol/providers/brokerRouteGrantV1';
import {
    DIRECT_ROUTE_GRANT_TTL_MS, readMachineIrohEndpointAuthorityV1,
    MachineOperationProtocolCapabilitiesV1StoredReadSchema, pluginJsonValuesEqual,
} from '@happier-dev/protocol';
import { auth } from '@/app/auth/auth';
import { classifyMachineAvailabilityState } from '@/app/machines/machineStateGuards';
import type { MachineDaemonPresenceInventory } from '@/app/machines/machineDaemonPresence';
import { inTx, type Tx } from '@/storage/inTx';
import { signRouteGrantPayload } from '@/app/machines/peer/mediation/mintDirectRouteGrantV1';
import { admitProviderBrokerConsumerInTx, type ProviderBrokerConsumerCurrentness } from './brokerConsumerAdmission';

type ConsumerResolver = (input: Readonly<{
    executionRunId: string; requestingAccountId: string; workerMachineId: string; expectedOccurrenceId: string | null;
}>) => Promise<(Readonly<{ ok: true }> & ProviderBrokerConsumerCurrentness) | Extract<ProviderBrokerAccountAdmissionResponseV2, { ok: false }>>;
type Common = Readonly<{
    homeId: string;
    actorAccountId: string;
    presence: MachineDaemonPresenceInventory;
    resolveExecutionRunCurrentness: ConsumerResolver;
}>;

async function readMachine(tx: Tx, accountId: string, machineId: string, presence: MachineDaemonPresenceInventory) {
    if (presence.state !== 'known' || !presence.machineIds.has(machineId)) return null;
    const machine = await tx.machine.findFirst({ where: { id: machineId, accountId }, select: {
        id: true, kind: true, revokedAt: true, replacedByMachineId: true,
        operationProtocolCapabilities: true, operationProtocolCapabilitiesRevision: true,
    } });
    if (!machine || classifyMachineAvailabilityState(machine) !== 'available') return null;
    const endpoint = readMachineIrohEndpointAuthorityV1({ capabilities: machine.operationProtocolCapabilities,
        revision: machine.operationProtocolCapabilitiesRevision });
    return endpoint ? { machine, endpoint } : null;
}

function supportsAccountConnectionIngress(capabilities: unknown): boolean {
    const parsed = MachineOperationProtocolCapabilitiesV1StoredReadSchema.safeParse(capabilities);
    return parsed.success && parsed.data.providerBrokerIngress?.protocolVersions.some(version => version === 2) === true;
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
    const run = request.consumer.kind === 'execution_run' ? await input.resolveExecutionRunCurrentness({
        executionRunId: request.consumer.executionRunId, requestingAccountId: input.actorAccountId,
        workerMachineId: request.initiatorMachineId, expectedOccurrenceId: refresh?.executionRunOccurrenceId ?? null,
    }) : null;
    if (run && !run.ok) return run;
    return await inTx(async tx => {
        if (!await auth.isSignedCredentialCurrent(tx, input.actorAccountId, input.tokenEpoch)) return { ok: false, reasonCode: 'operation_not_current' };
        const admitted = await admitProviderBrokerConsumerInTx(tx, { accountId: input.actorAccountId,
            initiatorMachineId: request.initiatorMachineId, consumer: request.consumer, executionRun: run });
        if (!admitted.ok) return admitted;
        const [initiator, target] = await Promise.all([
            readMachine(tx, input.actorAccountId, request.initiatorMachineId, input.presence),
            readMachine(tx, input.actorAccountId, request.targetMachineId, input.presence),
        ]);
        if (!initiator || !target || target.machine.kind !== 'persistent') return { ok: false, reasonCode: 'broker_unavailable' };
        if (!supportsAccountConnectionIngress(target.machine.operationProtocolCapabilities)) {
            return { ok: false, reasonCode: 'update_required' };
        }
        if (refresh && (refresh.initiator.endpointId !== initiator.endpoint.endpointId || refresh.target.endpointId !== target.endpoint.endpointId)) {
            return { ok: false, reasonCode: 'broker_unavailable' };
        }
        const payload = {
            v: 2 as const, grantId: input.grantId, aud: PROVIDER_BROKER_ROUTE_AUDIENCE_V2,
            issuedAt: input.nowMs, expiresAt: input.nowMs + DIRECT_ROUTE_GRANT_TTL_MS.directTcpTunnel,
            homeId: input.homeId, accountId: input.actorAccountId, source: request.source,
            initiatorTokenEpoch: input.tokenEpoch ?? 0,
            initiator: { accountId: input.actorAccountId, machineId: request.initiatorMachineId, endpointId: initiator.endpoint.endpointId },
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
}

export async function admitAccountConnectionProviderBroker(input: Common & Readonly<{
    request: ProviderBrokerAccountAdmissionV2;
    verifyAuthority(authority: ProviderBrokerAccountAdmissionV2['authority']): boolean;
}>): Promise<ProviderBrokerAccountAdmissionResponseV2> {
    const parsed = ProviderBrokerAccountAdmissionV2Schema.safeParse(input.request);
    if (!parsed.success || !input.verifyAuthority(parsed.data.authority)) return { ok: false, reasonCode: 'invalid_request' };
    const payload = parsed.data.authority.payload;
    if (payload.homeId !== input.homeId || payload.accountId !== input.actorAccountId) return { ok: false, reasonCode: 'resource_forbidden' };
    const run = payload.consumer.kind === 'execution_run' ? await input.resolveExecutionRunCurrentness({
        executionRunId: payload.consumer.executionRunId, requestingAccountId: input.actorAccountId,
        workerMachineId: payload.initiator.machineId, expectedOccurrenceId: payload.executionRunOccurrenceId ?? null,
    }) : null;
    if (run && !run.ok) return run;
    return await inTx(async tx => {
        if (!await auth.isSignedCredentialCurrent(tx, input.actorAccountId, payload.initiatorTokenEpoch)) return { ok: false, reasonCode: 'operation_not_current' };
        const admitted = await admitProviderBrokerConsumerInTx(tx, { accountId: input.actorAccountId,
            initiatorMachineId: payload.initiator.machineId, consumer: payload.consumer, executionRun: run });
        if (!admitted.ok) return admitted;
        const [initiator, target] = await Promise.all([
            readMachine(tx, input.actorAccountId, payload.initiator.machineId, input.presence),
            readMachine(tx, input.actorAccountId, payload.target.machineId, input.presence),
        ]);
        if (!initiator || !target || target.machine.kind !== 'persistent' || initiator.endpoint.endpointId !== payload.initiator.endpointId
            || target.endpoint.endpointId !== payload.target.endpointId) return { ok: false, reasonCode: 'broker_unavailable' };
        if (!supportsAccountConnectionIngress(target.machine.operationProtocolCapabilities)) return { ok: false, reasonCode: 'update_required' };
        return { ok: true };
    });
}
