/**
 * Public result and connection shapes for the tunnel frame layer.
 *
 * Split out of the former 1,498-line `frames.ts` (lane D3, 2026-08-23). Behaviour-preserving:
 * the declarations below are the original bytes, moved, with `PeerTcpTunnelStreamSessionFailure`
 * promoted to an export because the stream-session module now consumes it across a file boundary.
 */
import {
    type PeerTcpTunnelFrameV1,
} from '@happier-dev/protocol';

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
    | Readonly<{ ok: true; frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>; rawPayloadBytes: number }>
    | Readonly<{ ok: false; reasonCode: 'frame_invalid' | 'encoded_frame_too_large' | 'decoded_payload_too_large' }>;
