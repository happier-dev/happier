import {
    decodeBase64,
    decodePeerTcpTunnelBinaryFrameV2,
    encodeBase64,
    encodePeerTcpTunnelBinaryFrameV2,
    PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2,
    PeerTcpTunnelFrameV1Schema,
    type PeerTcpTunnelBinaryFrameHeaderV2,
    type PeerTcpTunnelEncoding,
    type PeerTcpTunnelFrameV1,
} from '@happier-dev/protocol';

export type DecodePeerTcpTunnelFrameForEncodingResult =
    | Readonly<{ ok: true; frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }> }>
    | Readonly<{ ok: false; reasonCode: 'frame_invalid' | 'payload_too_large' }>;

export type DecodePeerTcpTunnelSubstreamFrameResult =
    | Readonly<{ ok: true; substreamId: string; frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }> }>
    | Readonly<{ ok: false; reasonCode: 'frame_invalid' | 'payload_too_large' }>;

function requireDirection(header: PeerTcpTunnelBinaryFrameHeaderV2): NonNullable<PeerTcpTunnelBinaryFrameHeaderV2['direction']> | null {
    return header.direction ?? null;
}

function toBytes(payload: unknown): Uint8Array | null {
    if (payload instanceof Uint8Array) return payload;
    if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
    if (ArrayBuffer.isView(payload)) {
        return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength);
    }
    return null;
}

function parseJsonFrame(payload: unknown): DecodePeerTcpTunnelFrameForEncodingResult {
    let raw: unknown;
    try {
        if (typeof payload === 'string') {
            raw = JSON.parse(payload);
        } else {
            const bytes = toBytes(payload);
            if (!bytes) return { ok: false, reasonCode: 'frame_invalid' };
            raw = JSON.parse(new TextDecoder().decode(bytes));
        }
    } catch {
        return { ok: false, reasonCode: 'frame_invalid' };
    }
    const parsed = PeerTcpTunnelFrameV1Schema.safeParse(raw);
    if (!parsed.success || parsed.data.kind === 'open') {
        return { ok: false, reasonCode: 'frame_invalid' };
    }
    return { ok: true, frame: parsed.data };
}

function encodeBinaryFrame(frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>): Uint8Array {
    if (frame.kind === 'data') {
        const payload = decodeBase64(frame.payloadBase64);
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

export function encodePeerTcpTunnelSubstreamOpenFrameV2(input: Readonly<{
    tunnelId: string;
    substreamId: string;
}>): Uint8Array {
    return encodePeerTcpTunnelBinaryFrameV2({
        header: {
            version: 2,
            kind: 'open',
            tunnelId: input.tunnelId,
            substreamId: input.substreamId,
            payloadLength: 0,
        },
    });
}

export function encodePeerTcpTunnelSubstreamFrameV2(input: Readonly<{
    substreamId: string;
    frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;
}>): Uint8Array {
    if (input.frame.kind === 'data') {
        const payload = decodeBase64(input.frame.payloadBase64);
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

function decodeBinaryFrame(input: Readonly<{
    payload: unknown;
    maxFrameBytes: number;
}>): DecodePeerTcpTunnelFrameForEncodingResult {
    const bytes = toBytes(input.payload);
    if (!bytes) return { ok: false, reasonCode: 'frame_invalid' };
    const decoded = decodePeerTcpTunnelBinaryFrameV2({
        frame: bytes,
        maxHeaderBytes: input.maxFrameBytes,
        maxPayloadBytes: input.maxFrameBytes,
    });
    if (!decoded.ok) {
        return {
            ok: false,
            reasonCode: decoded.reasonCode === 'payload_too_large' || decoded.reasonCode === 'header_too_large'
                ? 'payload_too_large'
                : 'frame_invalid',
        };
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
                payloadBase64: encodeBase64(payload),
            },
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
        };
    }
    return { ok: false, reasonCode: 'frame_invalid' };
}

export function decodePeerTcpTunnelSubstreamFrameV2(input: Readonly<{
    payload: unknown;
    maxFrameBytes: number;
}>): DecodePeerTcpTunnelSubstreamFrameResult {
    const bytes = toBytes(input.payload);
    if (!bytes) return { ok: false, reasonCode: 'frame_invalid' };
    const decoded = decodePeerTcpTunnelBinaryFrameV2({
        frame: bytes,
        maxHeaderBytes: input.maxFrameBytes,
        maxPayloadBytes: input.maxFrameBytes,
    });
    if (!decoded.ok) {
        return {
            ok: false,
            reasonCode: decoded.reasonCode === 'payload_too_large' || decoded.reasonCode === 'header_too_large'
                ? 'payload_too_large'
                : 'frame_invalid',
        };
    }
    const substreamId = decoded.header.substreamId;
    if (!substreamId) return { ok: false, reasonCode: 'frame_invalid' };
    const legacy = decodeBinaryFrame(input);
    if (!legacy.ok) return legacy;
    return {
        ok: true,
        substreamId,
        frame: legacy.frame,
    };
}

export function encodePeerTcpTunnelFrameForEncoding(input: Readonly<{
    encoding: PeerTcpTunnelEncoding;
    frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;
}>): string | Uint8Array {
    return input.encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
        ? encodeBinaryFrame(input.frame)
        : JSON.stringify(input.frame);
}

export function decodePeerTcpTunnelFrameForEncoding(input: Readonly<{
    encoding: PeerTcpTunnelEncoding;
    payload: unknown;
    maxFrameBytes: number;
}>): DecodePeerTcpTunnelFrameForEncodingResult {
    return input.encoding === PEER_TCP_TUNNEL_BINARY_FRAME_ENCODING_V2
        ? decodeBinaryFrame(input)
        : parseJsonFrame(input.payload);
}
