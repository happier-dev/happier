/** Binary `binary_frame_v2` encode/decode for tunnel sessions and substreams. */
import {
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    type PeerTcpTunnelDirectionV1,
    type PeerTcpTunnelBinaryFrameHeaderV2,
} from '@happier-dev/protocol';
import type { PeerTcpTunnelBinaryFrameForSessionResult, PeerTcpTunnelFrame } from './types.js';

function requireDirection(header: PeerTcpTunnelBinaryFrameHeaderV2): PeerTcpTunnelDirectionV1 | null {
    return header.direction ?? null;
}

export function encodePeerTcpTunnelBinaryFrameForSubstream(input: Readonly<{
    frame: PeerTcpTunnelFrame;
    substreamId: string;
}>): Uint8Array {
    if (input.frame.kind === 'data') {
        const payload = input.frame.payload;
        return encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: input.frame.tunnelId,
                substreamId: input.substreamId,
                direction: input.frame.direction,
                sequence: input.frame.sequence,
                payloadLength: payload.byteLength,
            },
            payload,
        });
    }
    if (input.frame.kind === 'ack') {
        return encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'ack',
                tunnelId: input.frame.tunnelId,
                substreamId: input.substreamId,
                direction: input.frame.direction,
                ack: input.frame.nextSequence,
                window: input.frame.windowBytes,
                payloadLength: 0,
            },
        });
    }
    if (input.frame.kind === 'close') {
        return encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'close',
                tunnelId: input.frame.tunnelId,
                substreamId: input.substreamId,
                ...(input.frame.direction ? { direction: input.frame.direction } : {}),
                halfClose: input.frame.halfClose,
                reasonCode: input.frame.reasonCode,
                payloadLength: 0,
            },
        });
    }
    return encodePeerTcpTunnelBinaryFrameV2({
        header: {
            version: 2,
            kind: 'abort',
            tunnelId: input.frame.tunnelId,
            substreamId: input.substreamId,
            reasonCode: input.frame.reasonCode,
            payloadLength: 0,
        },
    });
}

export function decodePeerTcpTunnelBinaryFrameForSubstreamSession(input: Readonly<{
    header: PeerTcpTunnelBinaryFrameHeaderV2;
    payload: Uint8Array;
}>): PeerTcpTunnelFrame | null {
    const { header, payload } = input;
    if (header.kind === 'data') {
        const direction = requireDirection(header);
        if (!direction || header.sequence === undefined) return null;
        return {
            v: 1,
            kind: 'data',
            tunnelId: header.tunnelId,
            direction,
            sequence: header.sequence,
            payload,
        };
    }
    if (header.kind === 'ack') {
        const direction = requireDirection(header);
        if (!direction || header.ack === undefined || header.window === undefined) return null;
        return {
            v: 1,
            kind: 'ack',
            tunnelId: header.tunnelId,
            direction,
            nextSequence: header.ack,
            windowBytes: header.window,
        };
    }
    if (header.kind === 'close') {
        if (!header.reasonCode) return null;
        return {
            v: 1,
            kind: 'close',
            tunnelId: header.tunnelId,
            ...(header.direction ? { direction: header.direction } : {}),
            halfClose: header.halfClose ?? false,
            reasonCode: header.reasonCode,
        };
    }
    if (header.kind === 'abort') {
        if (!header.reasonCode) return null;
        return {
            v: 1,
            kind: 'abort',
            tunnelId: header.tunnelId,
            reasonCode: header.reasonCode,
        };
    }
    return null;
}

export function encodePeerTcpTunnelBinaryFrameForSession(
    frame: PeerTcpTunnelFrame,
): Uint8Array {
    if (frame.kind === 'data') {
        const payload = frame.payload;
        return encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'data',
                tunnelId: frame.tunnelId,
                direction: frame.direction,
                sequence: frame.sequence,
                payloadLength: payload.byteLength,
            },
            payload,
        });
    }
    if (frame.kind === 'ack') {
        return encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'ack',
                tunnelId: frame.tunnelId,
                direction: frame.direction,
                ack: frame.nextSequence,
                window: frame.windowBytes,
                payloadLength: 0,
            },
        });
    }
    if (frame.kind === 'close') {
        return encodePeerTcpTunnelBinaryFrameV2({
            header: {
                version: 2,
                kind: 'close',
                tunnelId: frame.tunnelId,
                ...(frame.direction ? { direction: frame.direction } : {}),
                halfClose: frame.halfClose,
                reasonCode: frame.reasonCode,
                payloadLength: 0,
            },
        });
    }
    return encodePeerTcpTunnelBinaryFrameV2({
        header: {
            version: 2,
            kind: 'abort',
            tunnelId: frame.tunnelId,
            reasonCode: frame.reasonCode,
            payloadLength: 0,
        },
    });
}

export function decodePeerTcpTunnelBinaryFrameForSession(input: Readonly<{
    frame: Uint8Array;
    maxBinaryHeaderBytes: number;
    maxRawPayloadBytes: number;
}>): PeerTcpTunnelBinaryFrameForSessionResult {
    const decoded = decodePeerTcpTunnelBinaryFrameV2({
        frame: input.frame,
        maxHeaderBytes: input.maxBinaryHeaderBytes,
        maxPayloadBytes: input.maxRawPayloadBytes,
    });
    if (!decoded.ok) {
        if (decoded.reasonCode === 'header_too_large') return { ok: false, reasonCode: 'encoded_frame_too_large' };
        if (decoded.reasonCode === 'payload_too_large') return { ok: false, reasonCode: 'decoded_payload_too_large' };
        return { ok: false, reasonCode: 'frame_invalid' };
    }

    const { header, payload } = decoded;
    if (header.kind === 'data') {
        const direction = requireDirection(header);
        if (!direction || header.sequence === undefined) return { ok: false, reasonCode: 'frame_invalid' };
        return {
            ok: true,
            frame: {
                v: 1,
                kind: 'data',
                tunnelId: header.tunnelId,
                direction,
                sequence: header.sequence,
                payload,
            },
            rawPayloadBytes: payload.byteLength,
        };
    }
    if (header.kind === 'ack') {
        const direction = requireDirection(header);
        if (!direction || header.ack === undefined || header.window === undefined) {
            return { ok: false, reasonCode: 'frame_invalid' };
        }
        return {
            ok: true,
            frame: {
                v: 1,
                kind: 'ack',
                tunnelId: header.tunnelId,
                direction,
                nextSequence: header.ack,
                windowBytes: header.window,
            },
            rawPayloadBytes: 0,
        };
    }
    if (header.kind === 'close') {
        if (!header.reasonCode) return { ok: false, reasonCode: 'frame_invalid' };
        return {
            ok: true,
            frame: {
                v: 1,
                kind: 'close',
                tunnelId: header.tunnelId,
                ...(header.direction ? { direction: header.direction } : {}),
                halfClose: header.halfClose ?? false,
                reasonCode: header.reasonCode,
            },
            rawPayloadBytes: 0,
        };
    }
    if (header.kind === 'abort') {
        if (!header.reasonCode) return { ok: false, reasonCode: 'frame_invalid' };
        return {
            ok: true,
            frame: {
                v: 1,
                kind: 'abort',
                tunnelId: header.tunnelId,
                reasonCode: header.reasonCode,
            },
            rawPayloadBytes: 0,
        };
    }
    return { ok: false, reasonCode: 'frame_invalid' };
}
