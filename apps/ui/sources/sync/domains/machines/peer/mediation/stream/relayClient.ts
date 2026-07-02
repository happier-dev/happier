import {
    MACHINE_LIVE_STREAM_SOCKET_EVENT,
    type MachineLiveStreamCapsV1,
    type MachineLiveStreamRelayEnvelopeV1,
    type MachineLiveStreamStartRequestV1,
} from '@happier-dev/protocol';

import {
    startProductionMachineLiveStream,
} from './productionRoute';

type StartProductionMachineLiveStream = typeof startProductionMachineLiveStream;

export type OpenMachineLiveStreamRelayClientResult = Readonly<
    | { ok: true; streamId: string }
    | { ok: false; reasonCode: string }
>;

function startEnvelope(startRequest: MachineLiveStreamStartRequestV1): MachineLiveStreamRelayEnvelopeV1 {
    return {
        v: 1,
        sourceMachineId: startRequest.sourceMachineId,
        targetMachineId: startRequest.targetMachineId,
        message: {
            kind: 'start',
            startRequest,
        },
    };
}

export async function openMachineLiveStreamRelayClient(input: Readonly<{
    serverId?: string | null;
    sourceMachineId: string;
    targetMachineId: string;
    streamId: string;
    streamFamily: string;
    caps: MachineLiveStreamCapsV1;
    timeoutMs?: number;
    startProduction?: StartProductionMachineLiveStream;
    send: (event: typeof MACHINE_LIVE_STREAM_SOCKET_EVENT, envelope: MachineLiveStreamRelayEnvelopeV1) => void;
}>): Promise<OpenMachineLiveStreamRelayClientResult> {
    const start = input.startProduction ?? startProductionMachineLiveStream;
    const started = await start({
        serverId: input.serverId,
        sourceMachineId: input.sourceMachineId,
        targetMachineId: input.targetMachineId,
        routeKind: 'server_relay',
        streamId: input.streamId,
        streamFamily: input.streamFamily,
        caps: input.caps,
        timeoutMs: input.timeoutMs,
    } satisfies Parameters<StartProductionMachineLiveStream>[0]);

    if (!started.ok) return { ok: false, reasonCode: started.reasonCode };
    if (started.routeKind !== 'server_relay') return { ok: false, reasonCode: 'unexpected_route_kind' };
    input.send(MACHINE_LIVE_STREAM_SOCKET_EVENT, startEnvelope(started.startRequest));
    return { ok: true, streamId: started.startRequest.streamId };
}
