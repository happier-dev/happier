import {
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    type PeerTcpTunnelEncoding,
} from '@happier-dev/protocol/machines/peer/mediation/tunnel/encoding';

export type MachineStreamRouteKind = 'loopback_direct' | 'server_relay';
export type MachineStreamDeliveryMode = 'demand_pull' | 'push_event' | 'input_append';
export type MachineStreamKind = 'audio_pcm' | 'terminal' | 'live_stream' | 'generic';
export type MachineStreamPayloadShape = 'bytes' | 'json_base64_envelope';
export const MACHINE_RPC_JSON_BASE64_ENCODING = 'machine_rpc_json_base64' as const;

export type MachineStreamFlowControlCapabilities = Readonly<{
    ack: boolean;
    creditBytes: boolean;
    byteOffsets: boolean;
    replayCursor: boolean;
    receipts: boolean;
}>;

export type MachineStreamOrderedInputAppendContract = Readonly<{
    sequenceField: 'seq';
    ackField: 'ackSeq';
    finalSequenceField: 'finalSeq';
}>;

export type MachineStreamPushEventSubscriptionContract = Readonly<{
    deliveryTrigger: 'subscription';
    pollIntervalMs: null;
}>;

export type MachineStreamCarrierProfile = Readonly<{
    routeKind: MachineStreamRouteKind;
    deliveryMode: MachineStreamDeliveryMode;
    streamKind: MachineStreamKind;
    binaryCapable: boolean;
    frameEncoding: PeerTcpTunnelEncoding | typeof MACHINE_RPC_JSON_BASE64_ENCODING;
    payloadShape: MachineStreamPayloadShape;
    flowControl: MachineStreamFlowControlCapabilities;
    orderedInputAppend?: MachineStreamOrderedInputAppendContract;
    pushEventSubscription?: MachineStreamPushEventSubscriptionContract;
}>;

export type TerminalStreamCarrierMapping = Readonly<{
    currentCarrierKind: 'machine-rpc-base64';
    routeKinds: readonly MachineStreamRouteKind[];
    deliveryMode: 'demand_pull';
    binaryCapable: false;
    frameEncoding: typeof MACHINE_RPC_JSON_BASE64_ENCODING;
    payloadShape: 'json_base64_envelope';
    migrationRequiredForB0: false;
    terminalCapabilities: Readonly<{
        ack: 'renderer byte offsets';
        credit: 'creditBytes';
        replay: 'byte-offset cursor';
        input: 'ordered sendInput queue';
    }>;
}>;

const ACK_CREDIT_REPLAY_FLOW_CONTROL: MachineStreamFlowControlCapabilities = Object.freeze({
    ack: true,
    creditBytes: true,
    byteOffsets: true,
    replayCursor: true,
    receipts: true,
});

const ORDERED_INPUT_APPEND_CONTRACT: MachineStreamOrderedInputAppendContract = Object.freeze({
    sequenceField: 'seq',
    ackField: 'ackSeq',
    finalSequenceField: 'finalSeq',
});

const PUSH_EVENT_SUBSCRIPTION_CONTRACT: MachineStreamPushEventSubscriptionContract = Object.freeze({
    deliveryTrigger: 'subscription',
    pollIntervalMs: null,
});

export function resolveMachineStreamCarrierProfile(input: Readonly<{
    routeKind: MachineStreamRouteKind;
    deliveryMode: MachineStreamDeliveryMode;
    streamKind: MachineStreamKind;
    binaryCapable: boolean;
}>): MachineStreamCarrierProfile {
    const usesTunnelBinaryFrame = input.binaryCapable;

    return {
        routeKind: input.routeKind,
        deliveryMode: input.deliveryMode,
        streamKind: input.streamKind,
        binaryCapable: usesTunnelBinaryFrame,
        frameEncoding: usesTunnelBinaryFrame
            ? PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
            : MACHINE_RPC_JSON_BASE64_ENCODING,
        payloadShape: usesTunnelBinaryFrame ? 'bytes' : 'json_base64_envelope',
        flowControl: ACK_CREDIT_REPLAY_FLOW_CONTROL,
        ...(input.deliveryMode === 'input_append'
            ? { orderedInputAppend: ORDERED_INPUT_APPEND_CONTRACT }
            : {}),
        ...(input.deliveryMode === 'push_event'
            ? { pushEventSubscription: PUSH_EVENT_SUBSCRIPTION_CONTRACT }
            : {}),
    };
}

export function describeTerminalStreamCarrierMapping(): TerminalStreamCarrierMapping {
    return {
        currentCarrierKind: 'machine-rpc-base64',
        routeKinds: ['loopback_direct', 'server_relay'],
        deliveryMode: 'demand_pull',
        binaryCapable: false,
        frameEncoding: MACHINE_RPC_JSON_BASE64_ENCODING,
        payloadShape: 'json_base64_envelope',
        migrationRequiredForB0: false,
        terminalCapabilities: {
            ack: 'renderer byte offsets',
            credit: 'creditBytes',
            replay: 'byte-offset cursor',
            input: 'ordered sendInput queue',
        },
    };
}
