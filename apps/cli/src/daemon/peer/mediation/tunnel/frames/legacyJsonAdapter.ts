/**
 * Compatibility adapter for the legacy JSON/base64 tunnel envelope.
 *
 * The duplex frame implementation lives in @happier-dev/peer-transport and
 * carries data as Uint8Array. This module is the sole JSON boundary used by
 * the CLI relay/socket paths; base64 conversion must not leak into the shared
 * transport core.
 */
import {
    decodeBase64,
    PeerTcpTunnelFrameV1Schema,
    validatePeerTcpTunnelDataFrameCaps,
    type PeerTcpTunnelFrameV1,
} from '@happier-dev/protocol';
import {
    createPeerTcpTunnelStreamSession as createBinaryStreamSession,
    decodePeerTcpTunnelBinaryFrameForSession as decodeBinaryFrame,
    encodePeerTcpTunnelBinaryFrameForSession as encodeBinaryFrame,
    type PeerTcpTunnelFrame as BinaryFrame,
    type PeerTcpTunnelStreamSessionResult,
    type PeerTcpTunnelStreamConnection,
} from '@happier-dev/peer-transport';

type LegacyFrame = Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;

function toBinary(frame: LegacyFrame): BinaryFrame {
    if (frame.kind !== 'data') return frame;
    return {
        v: 1,
        kind: 'data',
        tunnelId: frame.tunnelId,
        direction: frame.direction,
        sequence: frame.sequence,
        payload: decodeBase64(frame.payloadBase64),
    };
}

function toLegacy(frame: BinaryFrame): LegacyFrame {
    if (frame.kind !== 'data') return frame;
    return {
        v: 1,
        kind: 'data',
        tunnelId: frame.tunnelId,
        direction: frame.direction,
        sequence: frame.sequence,
        payloadBase64: Buffer.from(frame.payload).toString('base64'),
    };
}

export function encodePeerTcpTunnelBinaryFrameForSession(frame: LegacyFrame): Uint8Array {
    return encodeBinaryFrame(toBinary(frame));
}

export function decodePeerTcpTunnelBinaryFrameForSession(input: Readonly<{
    frame: Uint8Array;
    maxBinaryHeaderBytes: number;
    maxRawPayloadBytes: number;
}>) {
    const decoded = decodeBinaryFrame(input);
    if (!decoded.ok) return decoded;
    return { ...decoded, frame: toLegacy(decoded.frame) };
}

export function createPeerTcpTunnelStreamSession(input: Readonly<{
    tunnelId: string;
    initialWindowBytes: number;
    maxFrameBytes: number;
    maxEncodedFrameBytes?: number;
    maxDecodedPayloadBytes?: number;
    maxSendChunkBytes?: number;
    ackAfterBytes?: number;
    ackAfterMs?: number;
    maxIdleMs?: number;
    maxDurationMs?: number;
    maxTotalBytes?: number;
    nowMs?: () => number;
    connection: PeerTcpTunnelStreamConnection;
    sendFrame: (frame: PeerTcpTunnelFrameV1) => Promise<void> | void;
}>) {
    const maxEncodedFrameBytes = input.maxEncodedFrameBytes ?? input.maxFrameBytes;
    const maxDecodedPayloadBytes = input.maxDecodedPayloadBytes ?? input.maxFrameBytes;
    const session = createBinaryStreamSession({
        ...input,
        maxFrameBytes: maxDecodedPayloadBytes,
        maxDecodedPayloadBytes,
        sendFrame: (frame) => input.sendFrame(toLegacy(frame)),
    });
    return {
        ...session,
        async acceptFrame(raw: unknown): Promise<PeerTcpTunnelStreamSessionResult> {
            const parsed = PeerTcpTunnelFrameV1Schema.safeParse(raw);
            if (!parsed.success) {
                await input.sendFrame({ v: 1, kind: 'abort', tunnelId: input.tunnelId, reasonCode: 'frame_invalid' });
                return { ok: false, reasonCode: 'frame_invalid' };
            }
            const frame = parsed.data;
            if (frame.kind === 'data') {
                const caps = validatePeerTcpTunnelDataFrameCaps({
                    frame,
                    maxEncodedFrameBytes,
                    maxDecodedPayloadBytes,
                });
                if (!caps.ok) {
                    await input.sendFrame({
                        v: 1,
                        kind: 'abort',
                        tunnelId: input.tunnelId,
                        reasonCode: caps.reasonCode,
                    });
                    return { ok: false, reasonCode: caps.reasonCode };
                }
            }
            return session.acceptFrame(toBinary(frame as LegacyFrame));
        },
    };
}
