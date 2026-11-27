import type { MachineLiveStreamCapsV1, MachineLiveStreamStartRequestV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import type { MachineLiveStreamCodecIdV1} from '@happier-dev/protocol/machines/peer/mediation/stream/codecsV1';

import type { ProductionMachineLiveStreamStartResult } from './productionRoute';
import type { MachineLiveStreamRelayStartRpcResult } from './relayStartRpc';
import type { LiveStreamPlayerDiagnostic } from './diagnostics';

type StartProductionMachineLiveStreamInput = Readonly<{
    serverId?: string | null;
    expectedAccountId?: string;
    sessionId?: string;
    sourceMachineId: string;
    targetMachineId: string;
    routeKind: 'loopback_direct' | 'server_relay';
    streamId: string;
    streamFamily: string;
    sourceId?: string;
    viewerSocketId?: string | null;
    caps: MachineLiveStreamCapsV1;
    codecId?: MachineLiveStreamCodecIdV1;
    viewerCodecs?: readonly MachineLiveStreamCodecIdV1[];
    timeoutMs?: number;
    signal?: AbortSignal;
}>;

type StartProductionMachineLiveStream = (
    input: StartProductionMachineLiveStreamInput,
) => Promise<ProductionMachineLiveStreamStartResult>;

type StartDaemonRelay = (input: Readonly<{
    machineId: string;
    serverId?: string | null;
    sessionId?: string;
    startRequest: MachineLiveStreamStartRequestV1;
    timeoutMs?: number;
    signal?: AbortSignal;
}>) => Promise<MachineLiveStreamRelayStartRpcResult>;

export type OpenMachineLiveStreamRelayClientResult = Readonly<
    | { ok: true; streamId: string }
    | Extract<ProductionMachineLiveStreamStartResult, { ok: false }>
>;

async function defaultStartProductionMachineLiveStream(
    input: StartProductionMachineLiveStreamInput,
): Promise<ProductionMachineLiveStreamStartResult> {
    const { startProductionMachineLiveStream } = await import('./productionRoute');
    return await startProductionMachineLiveStream(input);
}

async function defaultStartDaemonRelay(
    input: Parameters<StartDaemonRelay>[0],
): Promise<MachineLiveStreamRelayStartRpcResult> {
    const { startMachineLiveStreamRelayViaMachineRpc } = await import('./relayStartRpc');
    return await startMachineLiveStreamRelayViaMachineRpc(input);
}

/**
 * Open a server-relayed live stream for the current viewer (SIM-P0-1 chokepoint).
 *
 * 1. Mint the Ed25519-signed relay authorization over HTTP (`startProduction`), viewer-bound
 *    via `viewerSocketId`.
 * 2. Deliver the signed startRequest to the capture daemon over the canonical machine-RPC
 *    channel (`startDaemonRelay`). The daemon starts capture and echoes the start on its own
 *    machine-scoped socket — the only socket the relay handler accepts starts from — where the
 *    server verifies the signature and creates the per-viewer relay state.
 *
 * The old path (emitting the start envelope on the viewer's user-scoped socket) was dead by
 * construction — the relay handler always rejected it with `source_machine_mismatch` — and has
 * been deleted.
 */
export type MachineLiveStreamRelayClientInput = Readonly<{
    serverId?: string | null;
    expectedAccountId?: string;
    sessionId?: string;
    sourceMachineId: string;
    targetMachineId: string;
    streamId: string;
    streamFamily: string;
    sourceId?: string;
    /** Exact mounted source occurrence, checked by the capture owner (not a relay grant). */
    sourceOccurrenceId?: string;
    viewerSocketId?: string | null;
    caps: MachineLiveStreamCapsV1;
    codecId?: MachineLiveStreamCodecIdV1;
    viewerCodecs?: readonly MachineLiveStreamCodecIdV1[];
    timeoutMs?: number;
    signal?: AbortSignal;
    startProduction?: StartProductionMachineLiveStream;
    startDaemonRelay?: StartDaemonRelay;
    onAuthorized?: (startRequest: MachineLiveStreamStartRequestV1) => void;
}>;

export async function renewMachineLiveStreamRelayClient(input: MachineLiveStreamRelayClientInput): Promise<ProductionMachineLiveStreamStartResult> {
    const start = input.startProduction ?? defaultStartProductionMachineLiveStream;
    return await start({
        serverId: input.serverId,
        ...(input.expectedAccountId ? { expectedAccountId: input.expectedAccountId } : {}),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        // The current direct HTTP start has no receive/control carrier. Only a
        // complete carrier may become a preferred route in the shared policy fold.
        routeKind: 'server_relay',
        streamId: input.streamId,
        streamFamily: input.streamFamily,
        ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        ...(input.viewerSocketId ? { viewerSocketId: input.viewerSocketId } : {}),
        caps: input.caps,
        ...(input.codecId ? { codecId: input.codecId } : {}),
        ...(input.viewerCodecs ? { viewerCodecs: input.viewerCodecs } : {}),
        timeoutMs: input.timeoutMs,
        signal: input.signal,
    } satisfies Parameters<StartProductionMachineLiveStream>[0]);
}

/** Renew the existing stream grant while its exact viewer is holding it. */
export function createMachineLiveStreamGrantRenewal(
    input: MachineLiveStreamRelayClientInput,
    send: (startRequest: MachineLiveStreamStartRequestV1) => void,
    fail: (reasonCode: string, failureCause?: LiveStreamPlayerDiagnostic['failureCause'],
        effectAttempted?: LiveStreamPlayerDiagnostic['effectAttempted']) => void,
) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const clear = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
    };
    return {
        close() { closed = true; clear(); },
        schedule(expiresAtMs: number) {
            clear();
            if (closed) return;
            const remainingMs = expiresAtMs - Date.now();
            if (remainingMs <= 0) { fail('grant_expired'); return; }
            // The relay returns the exact new expiry in grant_expiring.
            timer = setTimeout(() => {
                timer = undefined;
                void renewMachineLiveStreamRelayClient(input).then(result => {
                    if (closed) return;
                    if (!result.ok) { fail(result.reasonCode, result.failureCause, result.effectAttempted); return; }
                    send(result.startRequest);
                }).catch(() => { if (!closed) fail('grant_refresh_failed'); });
            }, remainingMs / 2);
        },
    };
}

export async function openMachineLiveStreamRelayClient(input: MachineLiveStreamRelayClientInput): Promise<OpenMachineLiveStreamRelayClientResult> {
    const started = await renewMachineLiveStreamRelayClient(input);
    if (input.signal?.aborted) return { ok: false, reasonCode: 'live_stream_relay_start_failed' };

    if (!started.ok) return started;
    if (started.routeKind !== 'server_relay') return { ok: false, reasonCode: 'unexpected_route_kind' };

    const startDaemonRelay = input.startDaemonRelay ?? defaultStartDaemonRelay;
    // Once admission begins, observe its original settlement even if the viewer
    // retires. Ingestion owes a final Stop for a late success on its original
    // Account transport; cancelling this RPC would hide that accepted stream.
    const daemonStarted = await startDaemonRelay({
        machineId: input.sourceMachineId,
        serverId: input.serverId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        startRequest: { ...started.startRequest, ...(input.sourceOccurrenceId ? { sourceOccurrenceId: input.sourceOccurrenceId } : {}) },
        ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
    });
    if (!daemonStarted.ok) return daemonStarted;
    input.onAuthorized?.(started.startRequest);
    return { ok: true, streamId: started.startRequest.streamId };
}
