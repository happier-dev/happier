import {
  PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
  PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
  type PeerTcpTunnelEncoding,
} from '@happier-dev/protocol';

import { encodeBase64 } from '@/encryption/base64';
import {
  resolveMachineStreamCarrierProfile,
  type MachineStreamCarrierProfile,
  type MachineStreamRouteKind,
} from '@/sync/domains/machines/peer/mediation/stream/carrier';

type DaemonSpeechStreamSequence = Readonly<{
  streamId: string;
  generation: number;
  seq: number;
}>;

type DaemonSpeechStreamCarrierFrameBase = Readonly<{
  profile: MachineStreamCarrierProfile;
  frameEncoding: PeerTcpTunnelEncoding;
  sequence: DaemonSpeechStreamSequence;
}>;

export type DaemonSpeechStreamBinaryFrameV2 = DaemonSpeechStreamCarrierFrameBase & Readonly<{
  kind: 'binary_tunnel_frame_v2';
  frameEncoding: typeof PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2;
  payloadBytes: Uint8Array;
}>;

export type DaemonSpeechStreamJsonBase64FallbackFrame = DaemonSpeechStreamCarrierFrameBase & Readonly<{
  kind: 'json_base64_v1_fallback';
  frameEncoding: typeof PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1;
  fallbackReason: 'carrier_binary_unavailable';
  jsonBase64Envelope: Readonly<{
    pcm16Base64: string;
  }>;
}>;

export type DaemonSpeechStreamCarrierFrame =
  | DaemonSpeechStreamBinaryFrameV2
  | DaemonSpeechStreamJsonBase64FallbackFrame;

export type DaemonSpeechStreamCarrierAdapter = Readonly<{
  profile: MachineStreamCarrierProfile;
  encodeInputAppendFrame: (input: DaemonSpeechStreamSequence & Readonly<{
    pcm16Bytes: Uint8Array;
  }>) => DaemonSpeechStreamCarrierFrame;
}>;

export type DaemonSpeechStreamRpcCompatibilityTransportDescriptor = Readonly<{
  kind: 'machine_rpc_json_base64_compatibility';
  carrierFrameEncoding: typeof PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1;
  payloadShape: 'json_base64_envelope';
}>;

export function createDaemonSpeechStreamCarrierAdapter(input: Readonly<{
  routeKind: MachineStreamRouteKind;
  binaryCapable: boolean;
}>): DaemonSpeechStreamCarrierAdapter {
  const profile = resolveMachineStreamCarrierProfile({
    routeKind: input.routeKind,
    deliveryMode: 'input_append',
    streamKind: 'audio_pcm',
    binaryCapable: input.binaryCapable,
  });

  return {
    profile,
    encodeInputAppendFrame: ({ streamId, generation, seq, pcm16Bytes }) => {
      const sequence = { streamId, generation, seq };
      if (profile.payloadShape === 'bytes') {
        return {
          kind: 'binary_tunnel_frame_v2',
          profile,
          frameEncoding: PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
          sequence,
          payloadBytes: new Uint8Array(pcm16Bytes),
        };
      }
      return {
        kind: 'json_base64_v1_fallback',
        profile,
        frameEncoding: PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
        sequence,
        fallbackReason: 'carrier_binary_unavailable',
        jsonBase64Envelope: {
          pcm16Base64: encodeBase64(pcm16Bytes),
        },
      };
    },
  };
}

export function createDaemonSpeechStreamRpcCompatibilityCarrierAdapter(): DaemonSpeechStreamCarrierAdapter {
  return createDaemonSpeechStreamCarrierAdapter({
    routeKind: 'loopback_direct',
    binaryCapable: false,
  });
}

export function describeDaemonSpeechStreamRpcCompatibilityTransport(): DaemonSpeechStreamRpcCompatibilityTransportDescriptor {
  return {
    kind: 'machine_rpc_json_base64_compatibility',
    carrierFrameEncoding: PEER_TCP_TUNNEL_JSON_BASE64_ENCODING_V1,
    payloadShape: 'json_base64_envelope',
  };
}
