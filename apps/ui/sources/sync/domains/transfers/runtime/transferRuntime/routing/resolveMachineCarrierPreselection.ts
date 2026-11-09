import { IrohEndpointDescriptorV1Schema, type IrohEndpointDescriptorV1 } from '@happier-dev/protocol/connectivity/iroh/endpointDescriptorV1';
import { readMachineIrohEndpointAuthorityV1, supportsMachineOperationProtocolCapabilityV1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import type { HomeApplicationCarrierEligibility } from '@happier-dev/cli-common/homeEnrollment';
import type { BrowserIrohHostDecision } from '@/sync/runtime/browserIroh/hostEligibility';

export type MachineCarrierHostEligibility =
    | Readonly<{ kind: 'browser'; lifecycleAvailable?: boolean }>
    | Readonly<{ kind: 'native'; lifecycleAvailable: boolean }>;

export type MachineCarrierPreselection =
    | Readonly<{
        kind: 'iroh_peer';
        carrierKind: 'browser_stream' | 'native_http';
        targetEndpoint: IrohEndpointDescriptorV1;
    }>
    | Readonly<{ kind: 'server_rpc' }>
    | Readonly<{ kind: 'unavailable' }>;

/** Some byte families already promise the encrypted Home route on every host. */
export type MachineCarrierRequirements = Readonly<{ homeRpcFallback?: 'required' }>;

/** Browser identity survives an unavailable Iroh lifecycle so Home RPC remains eligible. */
export function resolveMachineCarrierHostEligibility(input: Readonly<{
    browserIroh: BrowserIrohHostDecision;
    nativeLifecycleAvailable: boolean;
}>): MachineCarrierHostEligibility {
    if (input.browserIroh.eligible) return { kind: 'browser', lifecycleAvailable: true };
    if (input.browserIroh.reason === 'shared_worker_unsupported') return { kind: 'browser', lifecycleAvailable: false };
    return { kind: 'native', lifecycleAvailable: input.nativeLifecycleAvailable };
}

/**
 * The one reader for a Machine's declared finite-transfer RPC ingress. The
 * declaration is only trusted from a currently active, non-revoked Machine at a
 * server-assigned projection revision; absence is never support.
 */
export function isMachineFiniteTransferRpcDeclared(input: Readonly<{
    capabilities: unknown;
    revision: unknown;
    active?: boolean | null;
    revokedAt?: unknown;
}>): boolean {
    if (input.active === false || (input.revokedAt !== null && input.revokedAt !== undefined)) return false;
    if (!Number.isInteger(input.revision) || (input.revision as number) < 1) return false;
    return supportsMachineOperationProtocolCapabilityV1(input.capabilities, 'finiteTransferRpc');
}

/** The server-accepted Machine projection owns the current endpoint and hints. */
export function readCurrentMachineIrohEndpoint(input: Readonly<{
    capabilities: unknown;
    revision: unknown;
    active?: boolean | null;
    revokedAt?: unknown;
}>): IrohEndpointDescriptorV1 | null {
    if (input.active === false || (input.revokedAt !== null && input.revokedAt !== undefined)) return null;
    const authority = readMachineIrohEndpointAuthorityV1({
        capabilities: input.capabilities,
        revision: input.revision,
    });
    if (!authority) return null;
    return {
        endpointId: authority.endpointId,
        ...(authority.relayUrls ? { relayUrls: [...authority.relayUrls] } : {}),
        ...(authority.directAddresses ? { directAddresses: [...authority.directAddresses] } : {}),
    };
}

/** The feature contract for selecting the current Iroh Machine carrier. */
export function isIrohMachineCarrierFeatureEnabled(serverFeatures: ServerFeatures | null): boolean {
    return serverFeatures !== null
        && readServerEnabledBit(serverFeatures, 'machines.transfer.directPeer') === true
        && readServerEnabledBit(serverFeatures, 'machines.peerMediation') === true;
}

/** The one pure, pre-prepare finite-transfer route decision shared by controls and execution. */
export function resolveMachineCarrierPreselection(input: Readonly<{
    homeRpcFallback?: MachineCarrierRequirements['homeRpcFallback'];
    applicationCarrierEligibility?: HomeApplicationCarrierEligibility;
    serverFeatures: ServerFeatures | null;
    targetEndpoint: unknown;
    host: MachineCarrierHostEligibility;
    /** Exact current finite-transfer application support for this Machine role. */
    finiteTransferApplicationSupported: boolean;
    /** The current Machine supports Iroh's finite application, independently of Home RPC. */
    irohApplicationSupported: boolean;
}>): MachineCarrierPreselection {
    if (!input.finiteTransferApplicationSupported || !input.serverFeatures || readServerEnabledBit(input.serverFeatures, 'machines.transfer') !== true) {
        return { kind: 'unavailable' };
    }

    const endpoint = IrohEndpointDescriptorV1Schema.safeParse(input.targetEndpoint);
    if (
        input.applicationCarrierEligibility !== 'standard_only'
        && input.finiteTransferApplicationSupported
        && input.irohApplicationSupported
        && endpoint.success
        && isIrohMachineCarrierFeatureEnabled(input.serverFeatures)
    ) {
        if (input.host.kind === 'browser' && input.host.lifecycleAvailable !== false && (endpoint.data.relayUrls?.length ?? 0) > 0) {
            return { kind: 'iroh_peer', carrierKind: 'browser_stream', targetEndpoint: endpoint.data };
        }
        if (input.host.kind === 'native' && input.host.lifecycleAvailable) {
            return { kind: 'iroh_peer', carrierKind: 'native_http', targetEndpoint: endpoint.data };
        }
    }

    return input.host.kind === 'browser' || input.homeRpcFallback === 'required'
        ? { kind: 'server_rpc' } : { kind: 'unavailable' };
}
