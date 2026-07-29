import {
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
    type PeerTcpTunnelEncoding,
} from '@happier-dev/protocol';

export type MachineStreamRouteKind = 'loopback_direct' | 'server_relay';
export type MachineStreamDeliveryMode = 'demand_pull' | 'push_event' | 'input_append';
export type MachineStreamKind = 'audio_pcm' | 'terminal' | 'live_stream' | 'generic';
export type MachineStreamPayloadShape = 'bytes' | 'json_base64_envelope';

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
    frameEncoding: PeerTcpTunnelEncoding;
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
    frameEncoding: typeof PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1;
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
            : PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
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
        frameEncoding: PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
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
