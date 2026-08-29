/**
 * Public result and connection shapes for the tunnel frame layer.
 *
 * Split out of the former 1,498-line `frames.ts` (lane D3, 2026-08-23). Behaviour-preserving:
 * the declarations below are the original bytes, moved, with `PeerTcpTunnelStreamSessionFailure`
 * promoted to an export because the stream-session module now consumes it across a file boundary.
 */
import type {
    PeerTcpTunnelDestinationV1,
    PeerTcpTunnelDirectionV1,
    PeerTcpTunnelSubstreamCapsV2,
} from '@happier-dev/protocol';

export type PeerTcpTunnelDataFrame = Readonly<{
    v: 1;
    kind: 'data';
    tunnelId: string;
    direction: PeerTcpTunnelDirectionV1;
    sequence: number;
    payload: Uint8Array;
}>;

export type PeerTcpTunnelAckFrame = Readonly<{
    v: 1;
    kind: 'ack';
    tunnelId: string;
    direction: PeerTcpTunnelDirectionV1;
    nextSequence: number;
    windowBytes: number;
}>;

export type PeerTcpTunnelCloseFrame = Readonly<{
    v: 1;
    kind: 'close';
    tunnelId: string;
    direction?: PeerTcpTunnelDirectionV1;
    halfClose: boolean;
    reasonCode: string;
}>;

export type PeerTcpTunnelAbortFrame = Readonly<{
    v: 1;
    kind: 'abort';
    tunnelId: string;
    reasonCode: string;
}>;

export type PeerTcpTunnelFrame =
    | PeerTcpTunnelDataFrame
    | PeerTcpTunnelAckFrame
    | PeerTcpTunnelCloseFrame
    | PeerTcpTunnelAbortFrame;

export type PeerTcpTunnelStreamConnection = Readonly<{
    write?: (bytes: Uint8Array) => Promise<void> | void;
    endWrite?: () => Promise<void> | void;
    pauseRead?: () => Promise<void> | void;
    resumeRead?: () => Promise<void> | void;
    onData?: (handler: (bytes: Uint8Array) => Promise<void> | void) => (() => void) | void;
    close: () => Promise<void> | void;
}>;

export type PeerTcpTunnelStreamSessionResult =
    | Readonly<{ ok: true }>
    | Readonly<{
        ok: false;
        reasonCode:
            | 'direction_half_closed'
            | 'sequence_mismatch'
            | 'receive_window_exceeded'
            | 'frame_invalid'
            | 'encoded_frame_too_large'
            | 'payload_base64_invalid'
            | 'decoded_payload_too_large'
            | 'tunnel_id_mismatch'
            | 'direction_not_allowed'
            | 'ack_sequence_invalid'
            | 'send_window_exceeded'
            | 'total_bytes_exceeded'
            | 'max_idle_exceeded'
            | 'max_duration_exceeded'
            | 'tunnel_closed';
      }>;

export type PeerTcpTunnelStreamSessionFailure = Extract<PeerTcpTunnelStreamSessionResult, Readonly<{ ok: false }>>;

export type PeerTcpTunnelSubstreamMuxSessionResult =
    | Readonly<{ ok: true }>
    | Readonly<{
        ok: false;
        reasonCode:
            | PeerTcpTunnelStreamSessionFailure['reasonCode']
            | 'frame_invalid'
            | 'encoded_frame_too_large'
            | 'decoded_payload_too_large'
            | 'tunnel_id_mismatch'
            | 'substream_id_already_open'
            | 'substream_not_open'
            | 'substream_cap_exceeded'
            | 'tcp_connect_failed';
        substreamId?: string;
      }>;

export type PeerTcpTunnelApplicationSubstreamSessionResult = PeerTcpTunnelSubstreamMuxSessionResult;

export type PeerTcpTunnelBinaryFrameForSessionResult =
    | Readonly<{ ok: true; frame: PeerTcpTunnelFrame; rawPayloadBytes: number }>
    | Readonly<{ ok: false; reasonCode: 'frame_invalid' | 'encoded_frame_too_large' | 'decoded_payload_too_large' }>;

export type { PeerTcpTunnelDestinationV1, PeerTcpTunnelDirectionV1, PeerTcpTunnelSubstreamCapsV2 };
