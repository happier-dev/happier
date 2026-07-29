import {
    PeerTcpTunnelBinaryFrameHeaderV2Schema,
    type PeerTcpTunnelBinaryFrameHeaderV2,
} from '@happier-dev/protocol';

export type DecodePeerTcpTunnelBinaryRoutingHeaderV2Result =
    | Readonly<{ ok: true; header: PeerTcpTunnelBinaryFrameHeaderV2 }>
    | Readonly<{ ok: false }>;

type PeerTcpTunnelBinaryDecodeFailureReason = Exclude<
    ReturnType<(typeof import('@happier-dev/protocol'))['decodePeerTcpTunnelBinaryFrameV2']>,
    Readonly<{ ok: true }>
>['reasonCode'];

export function peerTcpTunnelBinaryDecodeFailureReason(
    reasonCode: PeerTcpTunnelBinaryDecodeFailureReason,
): 'encoded_frame_too_large' | 'decoded_payload_too_large' | 'frame_invalid' {
    if (reasonCode === 'header_too_large') return 'encoded_frame_too_large';
    if (reasonCode === 'payload_too_large') return 'decoded_payload_too_large';
    return 'frame_invalid';
}

const textDecoder = new TextDecoder();

/**
 * Recovers only the strict, size-bounded header used to select the owning
 * tunnel session. Payload admission remains exclusively with that owner.
 */
export function decodePeerTcpTunnelBinaryRoutingHeaderV2(input: Readonly<{
    frame: Uint8Array;
    maxHeaderBytes: number;
}>): DecodePeerTcpTunnelBinaryRoutingHeaderV2Result {
    if (input.frame.byteLength < 4) return { ok: false };

    const headerLength = new DataView(
        input.frame.buffer,
        input.frame.byteOffset,
        input.frame.byteLength,
    ).getUint32(0, false);
    if (headerLength < 1 || headerLength > input.maxHeaderBytes) return { ok: false };
    if (input.frame.byteLength < 4 + headerLength) return { ok: false };

    let headerJson: unknown;
    try {
        headerJson = JSON.parse(textDecoder.decode(input.frame.subarray(4, 4 + headerLength)));
    } catch {
        return { ok: false };
    }
    const parsed = PeerTcpTunnelBinaryFrameHeaderV2Schema.safeParse(headerJson);
    return parsed.success ? { ok: true, header: parsed.data } : { ok: false };
}
