import { DIRECT_ROUTE_GRANT_TTL_MS } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantCachePolicyV1';
import { DirectRouteGrantRequestV2Schema } from '@happier-dev/protocol/machines/peer/mediation/directRouteGrantV2';
import { IrohMachineHandshakeV1Schema } from '@happier-dev/protocol/connectivity/iroh/machineHandshakeV1';
import { createEphemeralPeerRouteProofHandleV2 } from '@happier-dev/protocol/machines/peer/mediation/ephemeralPeerRouteProofV2';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { requestPeerRouteGrantV2, resolveTargetServer } from '@/sync/domains/machines/peer/mediation/stream/productionRouteHttp';
import { readPeerEndpointForServerScope } from '@/sync/domains/machines/peer/mediation/readPeerEndpointForServerScope';
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { serverFetch } from '@/sync/http/client';
import { getIrohApplicationEndpoint, probeIrohMachineTransferLifecycleAvailability, startIrohMachineTransferTunnel } from '@/sync/runtime/nativeIrohTunnels/machineTransferLifecycle';
import { isBrowserIrohHost } from '@/sync/runtime/browserIroh/hostEligibility';
import { readHomeApplicationCarrierEligibility } from '@/sync/runtime/homeCarrierPolicy';
import { captureServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { parseToken } from '@/utils/auth/parseToken';
import { isMachineDaemonFiniteTransferApplicationSupported } from '../availability/machineDaemonTransferState';
import { isMachineFiniteTransferRpcDeclared, readCurrentMachineIrohEndpoint, resolveMachineCarrierPreselection } from '../routing/resolveMachineCarrierPreselection';

/** Stable user-facing failure copy for an operation pinned to machine/1. */
export const MACHINE_CARRIER_REQUIRED_TRANSFER_ERROR = 'A direct machine connection is required for this transfer.';
export const MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR = 'The direct machine connection was interrupted. Retry the transfer.';
export const MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE = 'machine_carrier_transport_failed' as const;
export const MACHINE_CARRIER_UNAVAILABLE_ERROR_CODE = 'machine_carrier_unavailable' as const;

function createMachineCarrierTransportFailure(cause: unknown): Error & Readonly<{
    errorCode: typeof MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE;
}> {
    if (
        cause instanceof Error
        && 'errorCode' in cause
        && cause.errorCode === MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE
    ) {
        return cause as Error & Readonly<{ errorCode: typeof MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE }>;
    }
    return Object.assign(new Error(MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR, { cause }), {
        errorCode: MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE,
    });
}

export type MachineCarrierHttpRequester = (
    input: RequestInfo | URL,
    init?: RequestInit,
) => Promise<Response>;

export type MachineCarrierHttpLease = Readonly<
    | {
        kind: 'native_http';
        localOrigin: string;
        release: () => Promise<void> | void;
    }
    | {
        kind: 'browser_stream';
        request: MachineCarrierHttpRequester;
        release: () => Promise<void>;
    }
>;

export type AcquireMachineCarrierHttpLease = (input: Readonly<{
    operationId: string;
    machineId: string;
    serverId?: string | null;
    signal?: AbortSignal;
}>) => Promise<MachineCarrierHttpLease>;

function readTargetIrohEndpoint(serverId: string, machineId: string) {
    const state = storage.getState();
    return readPeerEndpointForServerScope({
        state,
        serverId,
        machineId,
        select: (machine) => readCurrentMachineIrohEndpoint({
            capabilities: machine.operationProtocolCapabilities,
            revision: machine.operationProtocolCapabilitiesRevision,
            active: machine.active,
            revokedAt: machine.revokedAt,
        }),
    });
}

export type MachineCarrierRoute = Readonly<
    | { kind: 'unavailable'; error: string; errorCode: typeof MACHINE_CARRIER_UNAVAILABLE_ERROR_CODE }
    | {
        kind: 'iroh_peer';
        carrierKind: 'native_http' | 'browser_stream';
        acquire: (input: Readonly<{
            operationId: string;
            signal?: AbortSignal;
        }>) => Promise<MachineCarrierHttpLease>;
    }
>;

/** Reads the captured route without giving downstream callers a second decision. */
export function isIrohMachineCarrierRoute(
    route: MachineCarrierRoute | null | undefined,
): boolean {
    return route?.kind === 'iroh_peer';
}

/** One route decision for the whole transfer. Callers never reselect after prepare. */
export async function resolveMachineCarrierRoute(machineId: string, serverId?: string | null): Promise<MachineCarrierRoute> {
    const applicationCarrierEligibility = readHomeApplicationCarrierEligibility();
    const server = resolveTargetServer(serverId);
    if (!server) {
        return { kind: 'unavailable', error: MACHINE_CARRIER_REQUIRED_TRANSFER_ERROR, errorCode: MACHINE_CARRIER_UNAVAILABLE_ERROR_CODE };
    }
    const targetEndpoint = readTargetIrohEndpoint(server.serverId, machineId);
    const machineProjection = readPeerEndpointForServerScope({
        state: storage.getState(),
        serverId: server.serverId,
        machineId,
        select: (machine) => ({
            kind: machine.kind,
            active: machine.active,
            revokedAt: machine.revokedAt,
            daemonState: machine.daemonState,
            operationProtocolCapabilities: machine.operationProtocolCapabilities,
            operationProtocolCapabilitiesRevision: machine.operationProtocolCapabilitiesRevision,
        }),
    });
    const machineDaemonState = machineProjection?.daemonState;
    // A Runner publishes no daemon state at all, so its reachability comes from
    // the strict Machine declaration; persistent daemons declare their current
    // finite import/export application in daemon state.
    const runnerFiniteTransferRpcDeclared = machineProjection?.kind === 'ephemeral_session_runner' && isMachineFiniteTransferRpcDeclared({
        capabilities: machineProjection?.operationProtocolCapabilities,
        revision: machineProjection?.operationProtocolCapabilitiesRevision,
        active: machineProjection?.active,
        revokedAt: machineProjection?.revokedAt,
    });
    const finiteTransferApplicationSupported = machineProjection?.kind === 'ephemeral_session_runner'
        ? runnerFiniteTransferRpcDeclared
        : isMachineDaemonFiniteTransferApplicationSupported(machineDaemonState);
    if (!finiteTransferApplicationSupported) {
        return { kind: 'unavailable', error: MACHINE_CARRIER_REQUIRED_TRANSFER_ERROR, errorCode: MACHINE_CARRIER_UNAVAILABLE_ERROR_CODE };
    }
    const browserHost = isBrowserIrohHost();
    const host = browserHost
        ? { kind: 'browser' as const }
        : {
            kind: 'native' as const,
            lifecycleAvailable: targetEndpoint
                && applicationCarrierEligibility !== 'standard_only'
                ? await probeIrohMachineTransferLifecycleAvailability()
                : false,
        };
    const serverFeatures = await getReadyServerFeatures({ serverId: server.serverId });
    const preselection = resolveMachineCarrierPreselection({
        applicationCarrierEligibility,
        serverFeatures,
        targetEndpoint,
        host,
        finiteTransferApplicationSupported,
    });
    if (preselection.kind !== 'iroh_peer') {
        return { kind: 'unavailable', error: MACHINE_CARRIER_REQUIRED_TRANSFER_ERROR, errorCode: MACHINE_CARRIER_UNAVAILABLE_ERROR_CODE };
    }
    if (preselection.carrierKind === 'browser_stream') {
        return {
            kind: 'iroh_peer',
            carrierKind: 'browser_stream',
            acquire: async (input) => {
                try {
                    return await acquireBrowserMachineCarrierHttpLease({
                        ...input,
                        machineId,
                        serverId: server.serverId,
                    });
                } catch (error) {
                    throw createMachineCarrierTransportFailure(error);
                }
            },
        };
    }
    // One route decision for the whole transfer: capture the resolved server
    // at selection time so a later home-focus switch cannot re-scope the
    // deferred acquisition (mint, credentials, and handshake stay pinned to
    // the server selected here).
    return {
        kind: 'iroh_peer',
        carrierKind: 'native_http',
        acquire: async (input) => {
            try {
                return await acquireMachineCarrierHttpLease({
                    ...input,
                    machineId,
                    serverId: server.serverId,
                });
            } catch (error) {
                throw createMachineCarrierTransportFailure(error);
            }
        },
    };
}

export type SignedMachineCarrierHandshake = Readonly<{
    handshakeJson: string;
    signedTargetEndpointId: string;
    /** Newest descriptor hints observed for the signed target after minting. */
    currentTargetDirectAddresses: readonly string[];
    currentTargetRelayUrls: readonly string[];
}>;

/**
 * The one canonical machine/1 handshake mint for account-client initiators.
 * Native loopback leases and the browser relay stream share this owner so both
 * send exactly the same signed V2 grant, ephemeral proof, and handshake: a
 * carrier contributes only its own initiator endpoint identity and its byte
 * path after this returns. Every failure here is pre-transport — the calling
 * carrier has not opened anything yet.
 */
export async function mintSignedMachineCarrierHandshake(input: Readonly<{
    machineId: string;
    serverId?: string | null;
    /** Resolves the initiator EndpointId actually owned by the calling carrier. */
    resolveInitiatorEndpointId: (targetRelayUrls: readonly string[]) => Promise<string>;
}>): Promise<SignedMachineCarrierHandshake> {
    const server = resolveTargetServer(input.serverId);
    if (!server) throw new Error(MACHINE_CARRIER_REQUIRED_TRANSFER_ERROR);
    const credentials = await TokenStorage.getCredentialsForServerUrl(server.serverUrl, { serverId: server.serverId });
    const targetEndpoint = readTargetIrohEndpoint(server.serverId, input.machineId);
    if (!credentials || !targetEndpoint) throw new Error(MACHINE_CARRIER_REQUIRED_TRANSFER_ERROR);
    const accountScope = createServerAccountScope(server.serverId, parseToken(credentials.token));
    if (!accountScope) throw new Error(MACHINE_CARRIER_REQUIRED_TRANSFER_ERROR);

    const authority = await captureServerRequestAuthorityForServerAccountScope({
        scope: accountScope,
        activeRequest: async (path, init) => await serverFetch(path, init),
    });

    try {
        const initiatorEndpointId = await input.resolveInitiatorEndpointId(targetEndpoint.relayUrls ?? []);
        const proofHandle = createEphemeralPeerRouteProofHandleV2({ randomBytes: getRandomBytes });
        try {
            const request = DirectRouteGrantRequestV2Schema.parse({
                v: 2,
                kind: 'ephemeral_ed25519',
                ephemeralPublicKeyBase64Url: proofHandle.publicKeyBase64Url,
                machineId: input.machineId,
                flowKind: 'bounded_transfer',
                routeKind: 'iroh_peer',
                endpointFingerprint: targetEndpoint.endpointId,
                ttlMs: DIRECT_ROUTE_GRANT_TTL_MS.finiteTransferCarrier,
                scope: {
                    kind: 'bounded_transfer',
                    mode: 'carrier',
                },
                iroh: {
                    initiator: { kind: 'account_client', endpointId: initiatorEndpointId },
                    target: { machineId: input.machineId, endpointId: targetEndpoint.endpointId },
                    operationKind: 'finite_transfer',
                },
            });
            const granted = await requestPeerRouteGrantV2({ authority, request });
            if (!granted.ok) throw new Error(granted.reasonCode);
            const proof = proofHandle.sign(granted.value);
            const currentTarget = readTargetIrohEndpoint(server.serverId, input.machineId);
            const signedTarget = granted.value.payload.iroh?.target;
            if (!currentTarget || !signedTarget || currentTarget.endpointId !== signedTarget.endpointId) {
                throw new Error('Target Iroh endpoint changed while authorizing transfer');
            }
            const handshake = IrohMachineHandshakeV1Schema.parse({
                v: 1,
                accountId: granted.value.payload.accountId,
                initiator: granted.value.payload.iroh?.initiator,
                target: granted.value.payload.iroh?.target,
                flow: 'finite_transfer',
                grant: granted.value,
                proof,
            });
            return {
                handshakeJson: JSON.stringify(handshake),
                signedTargetEndpointId: signedTarget.endpointId,
                currentTargetDirectAddresses: currentTarget.directAddresses ?? [],
                currentTargetRelayUrls: currentTarget.relayUrls ?? [],
            };
        } finally {
            proofHandle.dispose();
        }
    } finally {
        await authority.release();
    }
}

/**
 * Production native account-client lease owner. The existing prepared-transfer
 * capability owns operation and payload size; V2 authorizes only the finite
 * transfer carrier and this owner starts one opaque fetch-facing native listener.
 */
export const acquireMachineCarrierHttpLease: AcquireMachineCarrierHttpLease = async (input) => {
    if (readHomeApplicationCarrierEligibility() === 'standard_only') {
        throw new Error(MACHINE_CARRIER_REQUIRED_TRANSFER_ERROR);
    }
    const minted = await mintSignedMachineCarrierHandshake({
        machineId: input.machineId,
        serverId: input.serverId,
        resolveInitiatorEndpointId: async (relayUrls) => {
            const applicationEndpoint = await getIrohApplicationEndpoint({ relayUrls });
            return applicationEndpoint.endpointId;
        },
    });
    const lease = await startIrohMachineTransferTunnel({
        endpointId: minted.signedTargetEndpointId,
        directAddresses: minted.currentTargetDirectAddresses,
        relayUrls: minted.currentTargetRelayUrls,
        handshakeJson: minted.handshakeJson,
    });
    return { kind: 'native_http', ...lease };
};

/**
 * Browser counterpart to the native loopback lease. The semantic transfer
 * owner still issues ordinary HTTP requests; one prepared transfer gets one
 * signed machine/1 admission and one caller-owned sequential HTTP connection
 * on the SharedWorker endpoint, without inventing a local origin.
 */
export const acquireBrowserMachineCarrierHttpLease: AcquireMachineCarrierHttpLease = async (input) => {
    if (readHomeApplicationCarrierEligibility() === 'standard_only') {
        throw new Error(MACHINE_CARRIER_REQUIRED_TRANSFER_ERROR);
    }
    const browserIroh = await import('@/sync/runtime/browserIroh');
    // The tab's one packaged endpoint client, shared with the Home carrier
    // owner (Lane 06). A transfer never closes it: releasing the operation
    // releases the stream and its endpoint lease through the connection close,
    // while pagehide/beforeunload owns the tab-client release lifecycle. The
    // SharedWorker endpoint itself is ephemeral and ends with that worker.
    const client = browserIroh.resolvePackagedBrowserIrohEndpointClient();
    const binding = browserIroh.createBrowserMachineCarrierEndpointBinding(client);
    // Custody taken during acquisition — including a failed cleanup release —
    // is handled by `acquireBrowserMachineCarrierStreamLease` itself; a shared
    // client is never torn down behind a failed operation.
    const streamLease = await import('./machineCarrierBrowserStream').then(
        ({ acquireBrowserMachineCarrierStreamLease }) => acquireBrowserMachineCarrierStreamLease({
            ...input,
            acquireEndpointLease: binding.acquireEndpointLease,
            openMachineCarrierStream: binding.openMachineCarrierStream,
        }),
    );

    const connection = browserIroh.createBrowserIrohHttpConnectionRequester({
        expectedRemoteEndpointId: streamLease.remoteEndpointId,
        stream: {
            streamId: input.operationId,
            remoteEndpointId: streamLease.remoteEndpointId,
            observedPath: streamLease.observedPath === 'relay' ? 'relay' : 'unknown',
            read: streamLease.duplex.read,
            write: streamLease.duplex.write,
            finishWrite: streamLease.duplex.finishWrite,
            cancel: async () => {
                await Promise.resolve(streamLease.duplex.cancel()).catch(() => undefined);
                await streamLease.release();
            },
            close: streamLease.release,
        },
    });
    let released = false;
    let releaseAttempt: Promise<void> | null = null;

    return {
        kind: 'browser_stream',
        request: connection.request,
        release: () => {
            if (released) return Promise.resolve();
            if (releaseAttempt === null) {
                releaseAttempt = (async () => {
                    // Closing the connection closes the carrier stream and
                    // releases the endpoint lease (retryable on failure). The
                    // shared per-tab client stays for the next operation.
                    await connection.close();
                    released = true;
                    releaseAttempt = null;
                })().catch((error: unknown) => {
                    releaseAttempt = null;
                    throw error;
                });
            }
            return releaseAttempt;
        },
    };
};

/** Accepts only an explicit loopback HTTP origin owned by the native machine tunnel. */
export function normalizeMachineCarrierHttpLocalOrigin(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const match = /^http:\/\/(127\.0\.0\.1|localhost):(\d{1,5})\/?$/i.exec(value.trim());
    if (!match) {
        return null;
    }
    const port = Number(match[2]);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        return null;
    }
    return `http://${match[1]!.toLowerCase()}:${port}`;
}

/** Replaces only the origin; the prepared transfer path and query remain authoritative. */
export function rebaseMachineCarrierHttpEndpoint(endpoint: string, localOrigin: string): string {
    const normalizedOrigin = normalizeMachineCarrierHttpLocalOrigin(localOrigin);
    if (!normalizedOrigin) {
        throw new Error('Machine carrier returned an invalid local HTTP origin');
    }
    const endpointUrl = new URL(endpoint);
    const originUrl = new URL(normalizedOrigin);
    endpointUrl.protocol = originUrl.protocol;
    endpointUrl.username = '';
    endpointUrl.password = '';
    endpointUrl.host = originUrl.host;
    return endpointUrl.toString();
}
