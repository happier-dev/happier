import { mintFiniteAccountClientTransferHandshake, readRpcRequestDisposition } from '@happier-dev/sync-client';
import { isMachineRpcTimeoutError, MACHINE_RPC_TIMEOUT_ERROR_CODE } from '@happier-dev/protocol/rpcErrors';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { getReadyServerFeatures } from '@/sync/api/capabilities/getReadyServerFeatures';
import { requestPeerRouteGrantV2, resolveTargetServer } from '@/sync/domains/machines/peer/mediation/stream/productionRouteHttp';
import { readPeerEndpointForServerScope } from '@/sync/domains/machines/peer/mediation/readPeerEndpointForServerScope';
import { readMachineInventoryRowReadiness } from '@/sync/domains/machines/resolveServerScopedMachines';
import { createServerAccountScope, areServerAccountScopesEqual, type ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { serverFetch } from '@/sync/http/client';
import { getIrohApplicationEndpoint, probeIrohMachineTransferLifecycleAvailability, startIrohMachineTransferTunnel } from '@/sync/runtime/nativeIrohTunnels/machineTransferLifecycle';
import { resolveBrowserIrohHostDecision } from '@/sync/runtime/browserIroh/hostEligibility';
import { readHomeApplicationCarrierEligibility } from '@/sync/runtime/homeCarrierPolicy';
import { getSyncSingleton } from '@/sync/runtime/getSyncSingleton';
import { captureServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { parseToken } from '@/utils/auth/parseToken';
import { isMachineDaemonFiniteTransferApplicationSupported, isMachineDaemonIrohTransferApplicationSupported } from '../availability/machineDaemonTransferState';
import { isMachineFiniteTransferRpcDeclared, readCurrentMachineIrohEndpoint, resolveMachineCarrierHostEligibility, resolveMachineCarrierPreselection, type MachineCarrierRequirements } from '../routing/resolveMachineCarrierPreselection';
import { createMachineCarrierServerRpcRequester } from './machineCarrierServerRpc';

/** Stable user-facing failure copy for an operation pinned to machine/1. */
export const MACHINE_CARRIER_REQUIRED_TRANSFER_ERROR = 'A direct machine connection is required for this transfer.';
export const MACHINE_CARRIER_INTERRUPTED_TRANSFER_ERROR = 'The direct machine connection was interrupted. Retry the transfer.';
export const MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE = 'machine_carrier_transport_failed' as const;
export const MACHINE_CARRIER_UNAVAILABLE_ERROR_CODE = 'machine_carrier_unavailable' as const;

export function createMachineCarrierTransportFailure(cause: unknown): Error & Readonly<{
    errorCode: typeof MACHINE_CARRIER_TRANSPORT_FAILED_ERROR_CODE | typeof MACHINE_RPC_TIMEOUT_ERROR_CODE;
}> {
    // A request's deadline is not evidence that its selected carrier broke.
    // Preserve the canonical timeout and its original cause through flattening.
    if (cause instanceof Error && isMachineRpcTimeoutError(cause)) {
        return Object.assign(cause, { errorCode: MACHINE_RPC_TIMEOUT_ERROR_CODE } as const);
    }
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
    | {
        kind: 'server_rpc';
        request: MachineCarrierHttpRequester;
        release: () => Promise<void>;
    }
>;

export type AcquireMachineCarrierHttpLease = (input: Readonly<{
    operationId: string;
    machineId: string;
    serverId?: string | null;
    signal?: AbortSignal;
    accountLifetime?: ServerAccountScopeLifetime;
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
    | ({
        /** The Home already selected by this canonical route decision. */
        serverId: string;
        acquire: (input: Readonly<{
            operationId: string;
            signal?: AbortSignal;
            accountLifetime?: ServerAccountScopeLifetime;
        }>) => Promise<MachineCarrierHttpLease>;
    } & (
        | { kind: 'iroh_peer'; carrierKind: 'native_http' | 'browser_stream' }
        | { kind: 'server_rpc'; carrierKind: 'server_rpc' }
    ))
>;

/** Reads the captured route without giving downstream callers a second decision. */
export function isIrohMachineCarrierRoute(
    route: MachineCarrierRoute | null | undefined,
): boolean {
    return route?.kind === 'iroh_peer';
}

/** The canonical route owner alone may fall back before any transfer phase is sent. */
export async function resolveMachineCarrierRoute(machineId: string, serverId?: string | null,
    requirements: MachineCarrierRequirements = {}): Promise<MachineCarrierRoute> {
    const applicationCarrierEligibility = readHomeApplicationCarrierEligibility();
    const server = resolveTargetServer(serverId);
    if (!server) {
        return { kind: 'unavailable', error: MACHINE_CARRIER_REQUIRED_TRANSFER_ERROR, errorCode: MACHINE_CARRIER_UNAVAILABLE_ERROR_CODE };
    }
    const retainedMachine = readPeerEndpointForServerScope({
        state: storage.getState(), serverId: server.serverId, machineId, select: machine => machine,
    });
    // Consume inventory readiness before reading the daemon declaration. Only
    // cold or pending content demands Sync; settled rows remain local reads.
    const machineProjection = retainedMachine && readMachineInventoryRowReadiness(retainedMachine) !== 'pending'
        ? retainedMachine
        : await getSyncSingleton().ensureMachineInventoryTarget({ serverId: server.serverId, machineId });
    const targetEndpoint = machineProjection ? readCurrentMachineIrohEndpoint({
        capabilities: machineProjection.operationProtocolCapabilities,
        revision: machineProjection.operationProtocolCapabilitiesRevision,
        active: machineProjection.active,
        revokedAt: machineProjection.revokedAt,
    }) : null;
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
    let host = resolveMachineCarrierHostEligibility({ browserIroh: resolveBrowserIrohHostDecision(), nativeLifecycleAvailable: false });
    if (host.kind === 'native' && targetEndpoint && applicationCarrierEligibility !== 'standard_only') {
        host = { kind: 'native', lifecycleAvailable: await probeIrohMachineTransferLifecycleAvailability() };
    }
    const serverFeatures = await getReadyServerFeatures({ serverId: server.serverId });
    const preselection = resolveMachineCarrierPreselection({
        ...requirements,
        applicationCarrierEligibility,
        serverFeatures,
        targetEndpoint,
        host,
        finiteTransferApplicationSupported,
        irohApplicationSupported: machineProjection?.kind === 'ephemeral_session_runner'
            ? runnerFiniteTransferRpcDeclared : isMachineDaemonIrohTransferApplicationSupported(machineDaemonState),
    });
    if (preselection.kind === 'unavailable') {
        return { kind: 'unavailable', error: MACHINE_CARRIER_REQUIRED_TRANSFER_ERROR, errorCode: MACHINE_CARRIER_UNAVAILABLE_ERROR_CODE };
    }
    const acquireHome: Extract<MachineCarrierRoute, { kind: 'server_rpc' }>['acquire'] = async input => {
        input.signal?.throwIfAborted();
        if (input.accountLifetime && !input.accountLifetime.isCurrent()) throw new Error('action_account_scope_changed');
        return { kind: 'server_rpc',
            request: createMachineCarrierServerRpcRequester({ ...input, machineId, serverId: server.serverId }),
            release: async () => {} };
    };
    if (preselection.kind === 'server_rpc') {
        return {
            kind: 'server_rpc', carrierKind: 'server_rpc', serverId: server.serverId,
            acquire: acquireHome,
        };
    }
    if (preselection.carrierKind === 'browser_stream') {
        return {
            kind: 'iroh_peer',
            carrierKind: 'browser_stream',
            serverId: server.serverId,
            acquire: async (input) => {
                try {
                    return await acquireBrowserMachineCarrierHttpLease({
                        ...input,
                        machineId,
                        serverId: server.serverId,
                    });
                } catch (error) {
                    if (readRpcRequestDisposition(error) === 'notSent') {
                        return await acquireHome(input);
                    }
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
        serverId: server.serverId,
        acquire: async (input) => {
            try {
                return await acquireMachineCarrierHttpLease({
                    ...input,
                    machineId,
                    serverId: server.serverId,
                });
            } catch (error) {
                if (requirements.homeRpcFallback === 'required' && readRpcRequestDisposition(error) === 'notSent') {
                    return await acquireHome(input);
                }
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
    accountLifetime?: ServerAccountScopeLifetime;
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
    const assertCurrent = () => {
        if (input.accountLifetime && (!input.accountLifetime.isCurrent()
            || !areServerAccountScopesEqual(input.accountLifetime.scope, accountScope))) throw new Error('action_account_scope_changed');
    };
    assertCurrent();

    const authority = await captureServerRequestAuthorityForServerAccountScope({
        scope: input.accountLifetime?.scope ?? accountScope,
        activeRequest: async (path, init) => await serverFetch(path, init),
    });

    try {
        const minted = await mintFiniteAccountClientTransferHandshake({ accountId: accountScope.accountId,
            machineId: input.machineId, readTargetEndpoint: () => readTargetIrohEndpoint(server.serverId, input.machineId),
            resolveInitiatorEndpointId: input.resolveInitiatorEndpointId, randomBytes: getRandomBytes,
            requestGrant: async request => {
                assertCurrent();
                const granted = await requestPeerRouteGrantV2({ authority, request });
                assertCurrent();
                if (!granted.ok) throw new Error(granted.reasonCode);
                return granted.value;
            } });
        return { handshakeJson: JSON.stringify(minted.handshake), signedTargetEndpointId: minted.endpoint.endpointId,
            currentTargetDirectAddresses: minted.endpoint.directAddresses ?? [], currentTargetRelayUrls: minted.endpoint.relayUrls ?? [] };
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
        accountLifetime: input.accountLifetime,
        resolveInitiatorEndpointId: async (relayUrls) => {
            const applicationEndpoint = await getIrohApplicationEndpoint({ relayUrls });
            return applicationEndpoint.endpointId;
        },
    });
    if (input.accountLifetime && !input.accountLifetime.isCurrent()) throw new Error('action_account_scope_changed');
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
