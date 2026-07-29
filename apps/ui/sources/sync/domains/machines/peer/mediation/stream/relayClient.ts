import type { MachineLiveStreamCapsV1, MachineLiveStreamStartRequestV1 } from '@happier-dev/protocol';

import type { ProductionMachineLiveStreamStartResult } from './productionRoute';
import type { MachineLiveStreamRelayStartRpcResult } from './relayStartRpc';

type StartProductionMachineLiveStreamInput = Readonly<{
    serverId?: string | null;
    sourceMachineId: string;
    targetMachineId: string;
    routeKind: 'loopback_direct' | 'server_relay';
    streamId: string;
    streamFamily: string;
    viewerSocketId?: string | null;
    caps: MachineLiveStreamCapsV1;
    timeoutMs?: number;
}>;

type StartProductionMachineLiveStream = (
    input: StartProductionMachineLiveStreamInput,
) => Promise<ProductionMachineLiveStreamStartResult>;

type StartDaemonRelay = (input: Readonly<{
    machineId: string;
    serverId?: string | null;
    startRequest: MachineLiveStreamStartRequestV1;
    timeoutMs?: number;
}>) => Promise<MachineLiveStreamRelayStartRpcResult>;

export type OpenMachineLiveStreamRelayClientResult = Readonly<
    | { ok: true; streamId: string }
    | { ok: false; reasonCode: string; requiredCapability?: string }
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
export async function openMachineLiveStreamRelayClient(input: Readonly<{
    serverId?: string | null;
    sourceMachineId: string;
    targetMachineId: string;
    streamId: string;
    streamFamily: string;
    viewerSocketId?: string | null;
    caps: MachineLiveStreamCapsV1;
    timeoutMs?: number;
    startProduction?: StartProductionMachineLiveStream;
    startDaemonRelay?: StartDaemonRelay;
}>): Promise<OpenMachineLiveStreamRelayClientResult> {
    const start = input.startProduction ?? defaultStartProductionMachineLiveStream;
    const startRoute = async (
        routeKind: StartProductionMachineLiveStreamInput['routeKind'],
    ): Promise<ProductionMachineLiveStreamStartResult> => await start({
        serverId: input.serverId,
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        routeKind,
        streamId: input.streamId,
        streamFamily: input.streamFamily,
        ...(input.viewerSocketId ? { viewerSocketId: input.viewerSocketId } : {}),
        caps: input.caps,
        timeoutMs: input.timeoutMs,
    } satisfies Parameters<StartProductionMachineLiveStream>[0]);

    const directStarted = await startRoute('loopback_direct');
    if (directStarted.ok) {
        if (directStarted.routeKind !== 'loopback_direct') {
            return { ok: false, reasonCode: 'unexpected_route_kind' };
        }
        if (!directStarted.response.ok) return { ok: false, reasonCode: directStarted.response.reasonCode };
        return { ok: true, streamId: directStarted.response.streamId };
    }

    const started = await startRoute('server_relay');

    if (!started.ok) {
        return directStarted.requiredCapability
            ? {
                ok: false,
                reasonCode: directStarted.reasonCode,
                requiredCapability: directStarted.requiredCapability,
            }
            : { ok: false, reasonCode: started.reasonCode };
    }
    if (started.routeKind !== 'server_relay') return { ok: false, reasonCode: 'unexpected_route_kind' };

    const startDaemonRelay = input.startDaemonRelay ?? defaultStartDaemonRelay;
    const daemonStarted = await startDaemonRelay({
        machineId: input.sourceMachineId,
        serverId: input.serverId,
        startRequest: started.startRequest,
        ...(typeof input.timeoutMs === 'number' ? { timeoutMs: input.timeoutMs } : {}),
    });
    if (!daemonStarted.ok) return { ok: false, reasonCode: daemonStarted.reasonCode };
    return { ok: true, streamId: started.startRequest.streamId };
}
