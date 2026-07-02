import {
    PEER_TCP_TUNNEL_ACK_AFTER_BYTES,
    PEER_TCP_TUNNEL_ACK_AFTER_MS,
    decodePeerTcpTunnelBinaryFrameV2,
    encodePeerTcpTunnelBinaryFrameV2,
    PeerTcpTunnelFrameV1Schema,
    validatePeerTcpTunnelDataFrameCaps,
    type PeerTcpTunnelDirectionV1,
    type PeerTcpTunnelBinaryFrameHeaderV2,
    type PeerTcpTunnelDestinationV1,
    type PeerTcpTunnelFrameV1,
    type PeerTcpTunnelSubstreamCapsV2,
} from '@happier-dev/protocol';

type DirectionState = {
    nextSequence: number;
    windowBytes: number;
    halfClosed: boolean;
    pendingAckBytes: number;
    lastAckMs: number;
};

type SendCreditState = {
    nextSequence: number;
    acknowledgedSequence: number;
    windowBytes: number;
};

type FrameAccountingResult =
    | Readonly<{ ok: true; nextSequence: number; windowBytes: number }>
    | Readonly<{ ok: false; reasonCode: 'direction_half_closed' | 'sequence_mismatch' | 'receive_window_exceeded' }>;

const MAX_SCHEDULABLE_TIMEOUT_MS = 2_147_483_647;

export type PeerTcpTunnelWebSocketDecodeResult = Readonly<{
    frames: readonly string[];
    remaining: Buffer<ArrayBufferLike>;
    close: boolean;
    errorCode?: 'frame_too_large' | 'masked_frame_required' | 'unsupported_frame';
}>;

function createDirectionState(initialWindowBytes: number): DirectionState {
    return {
        nextSequence: 0,
        windowBytes: initialWindowBytes,
        halfClosed: false,
        pendingAckBytes: 0,
        lastAckMs: 0,
    };
}

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

type PeerTcpTunnelStreamSessionFailure = Extract<PeerTcpTunnelStreamSessionResult, Readonly<{ ok: false }>>;

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

export type PeerTcpTunnelBinaryFrameForSessionResult =
    | Readonly<{ ok: true; frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>; rawPayloadBytes: number }>
    | Readonly<{ ok: false; reasonCode: 'frame_invalid' | 'encoded_frame_too_large' | 'decoded_payload_too_large' }>;

function decodePayloadBase64(payloadBase64: string): Uint8Array {
    return new Uint8Array(Buffer.from(payloadBase64, 'base64'));
}

function encodePayloadBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

function requireDirection(header: PeerTcpTunnelBinaryFrameHeaderV2): PeerTcpTunnelDirectionV1 | null {
    return header.direction ?? null;
}

function encodePeerTcpTunnelBinaryFrameForSubstream(input: Readonly<{
    frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>;
    substreamId: string;
}>): Uint8Array {
    if (input.frame.kind === 'data') {
        const payload = decodePayloadBase64(input.frame.payloadBase64);
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

function decodePeerTcpTunnelBinaryFrameForSubstreamSession(input: Readonly<{
    header: PeerTcpTunnelBinaryFrameHeaderV2;
    payload: Uint8Array;
}>): Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }> | null {
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
            payloadBase64: encodePayloadBase64(payload),
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
    frame: Exclude<PeerTcpTunnelFrameV1, { kind: 'open' }>,
): Uint8Array {
    if (frame.kind === 'data') {
        const payload = decodePayloadBase64(frame.payloadBase64);
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
                payloadBase64: encodePayloadBase64(payload),
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

type ActivePeerTcpTunnelSubstream = {
    connection: PeerTcpTunnelStreamConnection;
    session: ReturnType<typeof createPeerTcpTunnelStreamSession>;
    bytes: number;
    lastActivityMs: number;
    idleTimer?: ReturnType<typeof setTimeout>;
};

function substreamAbortFrame(input: Readonly<{
    tunnelId: string;
    substreamId: string;
    reasonCode: string;
}>): Uint8Array {
    return encodePeerTcpTunnelBinaryFrameV2({
        header: {
            version: 2,
            kind: 'abort',
            tunnelId: input.tunnelId,
            substreamId: input.substreamId,
            reasonCode: input.reasonCode,
            payloadLength: 0,
        },
    });
}

export function createPeerTcpTunnelSubstreamMuxSession(input: Readonly<{
    tunnelId: string;
    destination: PeerTcpTunnelDestinationV1;
    initialWindowBytes: number;
    maxFrameBytes: number;
    maxBinaryHeaderBytes: number;
    maxRawPayloadBytes: number;
    caps: PeerTcpTunnelSubstreamCapsV2;
    connectTcp: (target: PeerTcpTunnelDestinationV1) => Promise<PeerTcpTunnelStreamConnection>;
    sendBinaryFrame: (frame: Uint8Array) => Promise<void> | void;
    nowMs?: () => number;
}>) {
    const nowMs = input.nowMs ?? Date.now;
    const activeSubstreams = new Map<string, ActivePeerTcpTunnelSubstream>();
    const openedSubstreamIds = new Set<string>();
    let aggregateBytes = 0;
    let lastSessionActivityMs = nowMs();
    let closed = false;
    let sessionIdleTimer: ReturnType<typeof setTimeout> | undefined;

    function clearSessionIdleTimer(): void {
        if (sessionIdleTimer) clearTimeout(sessionIdleTimer);
        sessionIdleTimer = undefined;
    }

    function scheduleSessionIdleTimer(): void {
        if (closed || !isSchedulableTimeoutMs(input.caps.maxSessionIdleMs)) return;
        clearSessionIdleTimer();
        sessionIdleTimer = setTimeout(() => {
            void closeAll('max_idle_exceeded');
        }, input.caps.maxSessionIdleMs);
        sessionIdleTimer.unref?.();
    }

    function scheduleSubstreamIdleTimer(substreamId: string, active: ActivePeerTcpTunnelSubstream): void {
        if (!isSchedulableTimeoutMs(input.caps.maxSubstreamIdleMs)) return;
        if (active.idleTimer) clearTimeout(active.idleTimer);
        active.idleTimer = setTimeout(() => {
            void abortAndCloseSubstream(substreamId, 'max_idle_exceeded');
        }, input.caps.maxSubstreamIdleMs);
        active.idleTimer.unref?.();
    }

    function recordSessionActivity(): void {
        lastSessionActivityMs = nowMs();
        scheduleSessionIdleTimer();
    }

    function clearSubstreamTimer(active: ActivePeerTcpTunnelSubstream): void {
        if (active.idleTimer) clearTimeout(active.idleTimer);
        active.idleTimer = undefined;
    }

    async function sendSubstreamAbort(substreamId: string, reasonCode: string): Promise<void> {
        await input.sendBinaryFrame(substreamAbortFrame({
            tunnelId: input.tunnelId,
            substreamId,
            reasonCode,
        }));
    }

    async function closeSubstream(substreamId: string): Promise<void> {
        const active = activeSubstreams.get(substreamId);
        if (!active) return;
        activeSubstreams.delete(substreamId);
        clearSubstreamTimer(active);
        await active.connection.close();
    }

    async function abortAndCloseSubstream(substreamId: string, reasonCode: string): Promise<void> {
        await sendSubstreamAbort(substreamId, reasonCode);
        await closeSubstream(substreamId);
    }

    async function closeAll(reasonCode?: string): Promise<void> {
        if (closed) return;
        closed = true;
        clearSessionIdleTimer();
        const substreamIds = [...activeSubstreams.keys()];
        await Promise.all(substreamIds.map(async (substreamId) => {
            if (reasonCode) await sendSubstreamAbort(substreamId, reasonCode);
            await closeSubstream(substreamId);
        }));
    }

    function canRecordBytes(substreamId: string, bytes: number): PeerTcpTunnelSubstreamMuxSessionResult {
        const active = activeSubstreams.get(substreamId);
        if (!active) return { ok: false, reasonCode: 'substream_not_open', substreamId };
        if (active.bytes + bytes > input.caps.maxBytesPerSubstream) {
            return { ok: false, reasonCode: 'substream_cap_exceeded', substreamId };
        }
        if (aggregateBytes + bytes > input.caps.maxAggregateBytes) {
            return { ok: false, reasonCode: 'substream_cap_exceeded', substreamId };
        }
        return { ok: true };
    }

    function recordBytes(substreamId: string, bytes: number): void {
        const active = activeSubstreams.get(substreamId);
        if (!active) return;
        active.bytes += bytes;
        aggregateBytes += bytes;
        active.lastActivityMs = nowMs();
        recordSessionActivity();
        scheduleSubstreamIdleTimer(substreamId, active);
    }

    async function openSubstream(substreamId: string): Promise<PeerTcpTunnelSubstreamMuxSessionResult> {
        if (closed) return { ok: false, reasonCode: 'tunnel_closed', substreamId };
        if (activeSubstreams.has(substreamId)) {
            await sendSubstreamAbort(substreamId, 'substream_id_already_open');
            return { ok: false, reasonCode: 'substream_id_already_open', substreamId };
        }
        if (
            activeSubstreams.size >= input.caps.maxConcurrentSubstreams
            || openedSubstreamIds.size >= input.caps.maxTotalSubstreams
        ) {
            await sendSubstreamAbort(substreamId, 'substream_cap_exceeded');
            return { ok: false, reasonCode: 'substream_cap_exceeded', substreamId };
        }

        let connection: PeerTcpTunnelStreamConnection;
        try {
            connection = await input.connectTcp(input.destination);
        } catch {
            await sendSubstreamAbort(substreamId, 'tcp_connect_failed');
            return { ok: false, reasonCode: 'tcp_connect_failed', substreamId };
        }

        let active: ActivePeerTcpTunnelSubstream;
        const session = createPeerTcpTunnelStreamSession({
            tunnelId: input.tunnelId,
            initialWindowBytes: input.initialWindowBytes,
            maxFrameBytes: input.maxFrameBytes,
            maxIdleMs: input.caps.maxSubstreamIdleMs,
            maxDurationMs: Number.MAX_SAFE_INTEGER,
            maxTotalBytes: input.caps.maxBytesPerSubstream,
            nowMs,
            connection,
            sendFrame: async (frame) => {
                if (frame.kind === 'open') return;
                if (frame.kind === 'data') {
                    const bytes = decodePayloadBase64(frame.payloadBase64).byteLength;
                    const accepted = canRecordBytes(substreamId, bytes);
                    if (!accepted.ok) {
                        await abortAndCloseSubstream(substreamId, accepted.reasonCode);
                        return;
                    }
                    recordBytes(substreamId, bytes);
                } else {
                    active.lastActivityMs = nowMs();
                    recordSessionActivity();
                    scheduleSubstreamIdleTimer(substreamId, active);
                }
                await input.sendBinaryFrame(encodePeerTcpTunnelBinaryFrameForSubstream({
                    frame,
                    substreamId,
                }));
                if (frame.kind === 'close' && !frame.halfClose) {
                    await closeSubstream(substreamId);
                }
                if (frame.kind === 'abort') {
                    await closeSubstream(substreamId);
                }
            },
        });

        active = {
            connection,
            session,
            bytes: 0,
            lastActivityMs: nowMs(),
        };
        activeSubstreams.set(substreamId, active);
        openedSubstreamIds.add(substreamId);
        recordSessionActivity();
        scheduleSubstreamIdleTimer(substreamId, active);
        return { ok: true };
    }

    scheduleSessionIdleTimer();

    return {
        async acceptBinaryFrame(raw: Uint8Array): Promise<PeerTcpTunnelSubstreamMuxSessionResult> {
            const decoded = decodePeerTcpTunnelBinaryFrameV2({
                frame: raw,
                maxHeaderBytes: input.maxBinaryHeaderBytes,
                maxPayloadBytes: input.maxRawPayloadBytes,
            });
            if (!decoded.ok) {
                if (decoded.reasonCode === 'header_too_large') return { ok: false, reasonCode: 'encoded_frame_too_large' };
                if (decoded.reasonCode === 'payload_too_large') return { ok: false, reasonCode: 'decoded_payload_too_large' };
                return { ok: false, reasonCode: 'frame_invalid' };
            }
            if (decoded.header.tunnelId !== input.tunnelId) {
                return { ok: false, reasonCode: 'tunnel_id_mismatch' };
            }
            const substreamId = decoded.header.substreamId;
            if (!substreamId) return { ok: false, reasonCode: 'frame_invalid' };

            if (closed) return { ok: false, reasonCode: 'tunnel_closed', substreamId };
            const now = nowMs();
            if (now - lastSessionActivityMs > input.caps.maxSessionIdleMs) {
                await closeAll('max_idle_exceeded');
                return { ok: false, reasonCode: 'max_idle_exceeded', substreamId };
            }

            if (decoded.header.kind === 'open') {
                if (decoded.payload.byteLength !== 0) return { ok: false, reasonCode: 'frame_invalid', substreamId };
                return openSubstream(substreamId);
            }

            const active = activeSubstreams.get(substreamId);
            if (!active) {
                await sendSubstreamAbort(substreamId, 'substream_not_open');
                return { ok: false, reasonCode: 'substream_not_open', substreamId };
            }
            if (now - active.lastActivityMs > input.caps.maxSubstreamIdleMs) {
                await abortAndCloseSubstream(substreamId, 'max_idle_exceeded');
                return { ok: false, reasonCode: 'max_idle_exceeded', substreamId };
            }
            const frame = decodePeerTcpTunnelBinaryFrameForSubstreamSession({
                header: decoded.header,
                payload: decoded.payload,
            });
            if (!frame) {
                await sendSubstreamAbort(substreamId, 'frame_invalid');
                return { ok: false, reasonCode: 'frame_invalid', substreamId };
            }
            if (frame.kind === 'data') {
                const accepted = canRecordBytes(substreamId, decoded.payload.byteLength);
                if (!accepted.ok) {
                    await abortAndCloseSubstream(substreamId, accepted.reasonCode);
                    return accepted;
                }
            }

            const result = await active.session.acceptFrame(frame);
            if (!result.ok) return { ...result, substreamId };
            if (frame.kind === 'data') {
                recordBytes(substreamId, decoded.payload.byteLength);
            } else {
                active.lastActivityMs = nowMs();
                recordSessionActivity();
                scheduleSubstreamIdleTimer(substreamId, active);
            }
            if (frame.kind === 'close' && !frame.halfClose) {
                await closeSubstream(substreamId);
            }
            if (frame.kind === 'abort') {
                await closeSubstream(substreamId);
            }
            return { ok: true };
        },
        close: () => closeAll(),
    };
}

function abortFrame(tunnelId: string, reasonCode: string): PeerTcpTunnelFrameV1 {
    return {
        v: 1,
        kind: 'abort',
        tunnelId,
        reasonCode,
    };
}

function isSchedulableTimeoutMs(value: number | undefined): value is number {
    return typeof value === 'number'
        && Number.isFinite(value)
        && value >= 1
        && value <= MAX_SCHEDULABLE_TIMEOUT_MS;
}

export function encodePeerTcpTunnelWebSocketTextFrame(payload: string): Buffer {
    const payloadBytes = Buffer.from(payload, 'utf8');
    if (payloadBytes.byteLength < 126) {
        return Buffer.concat([Buffer.from([0x81, payloadBytes.byteLength]), payloadBytes]);
    }
    if (payloadBytes.byteLength <= 0xffff) {
        const header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payloadBytes.byteLength, 2);
        return Buffer.concat([header, payloadBytes]);
    }
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payloadBytes.byteLength), 2);
    return Buffer.concat([header, payloadBytes]);
}

export function decodePeerTcpTunnelWebSocketClientFrames(input: Readonly<{
    buffer: Buffer<ArrayBufferLike>;
    maxFrameBytes: number;
}>): PeerTcpTunnelWebSocketDecodeResult {
    const frames: string[] = [];
    let offset = 0;
    let close = false;

    while (offset + 2 <= input.buffer.byteLength) {
        const first = input.buffer[offset]!;
        const second = input.buffer[offset + 1]!;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) === 0x80;
        let payloadLength = second & 0x7f;
        let headerLength = 2;

        if (payloadLength === 126) {
            if (offset + 4 > input.buffer.byteLength) break;
            payloadLength = input.buffer.readUInt16BE(offset + 2);
            headerLength = 4;
        } else if (payloadLength === 127) {
            if (offset + 10 > input.buffer.byteLength) break;
            const wideLength = input.buffer.readBigUInt64BE(offset + 2);
            if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) {
                return { frames, remaining: Buffer.alloc(0), close, errorCode: 'frame_too_large' };
            }
            payloadLength = Number(wideLength);
            headerLength = 10;
        }

        if (payloadLength > input.maxFrameBytes) {
            return {
                frames,
                remaining: input.buffer.subarray(offset),
                close,
                errorCode: 'frame_too_large',
            };
        }
        if (!masked) {
            return {
                frames,
                remaining: input.buffer.subarray(offset),
                close,
                errorCode: 'masked_frame_required',
            };
        }

        const maskStart = offset + headerLength;
        const payloadStart = maskStart + 4;
        const frameEnd = payloadStart + payloadLength;
        if (frameEnd > input.buffer.byteLength) break;

        const mask = input.buffer.subarray(maskStart, payloadStart);
        const payload = Buffer.alloc(payloadLength);
        for (let index = 0; index < payloadLength; index += 1) {
            payload[index] = input.buffer[payloadStart + index]! ^ mask[index % 4]!;
        }

        if (opcode === 0x8) {
            close = true;
        } else if (opcode === 0x1) {
            frames.push(payload.toString('utf8'));
        } else if (opcode !== 0x9 && opcode !== 0xa) {
            return {
                frames,
                remaining: input.buffer.subarray(frameEnd),
                close,
                errorCode: 'unsupported_frame',
            };
        }

        offset = frameEnd;
    }

    return {
        frames,
        remaining: Buffer.from(input.buffer.subarray(offset)),
        close,
    };
}

export function createPeerTcpTunnelFrameAccounting(input: Readonly<{
    initialWindowBytes: number;
    nowMs?: () => number;
}>) {
    const initialWindowBytes = Math.max(0, Math.floor(input.initialWindowBytes));
    const nowMs = input.nowMs ?? Date.now;
    const state: Record<PeerTcpTunnelDirectionV1, DirectionState> = {
        client_to_daemon: createDirectionState(initialWindowBytes),
        daemon_to_client: createDirectionState(initialWindowBytes),
    };
    state.client_to_daemon.lastAckMs = nowMs();
    state.daemon_to_client.lastAckMs = nowMs();

    return {
        acceptData(input: Readonly<{
            direction: PeerTcpTunnelDirectionV1;
            sequence: number;
            decodedBytes: number;
        }>): FrameAccountingResult {
            const direction = state[input.direction];
            if (direction.halfClosed) return { ok: false, reasonCode: 'direction_half_closed' };
            if (input.sequence !== direction.nextSequence) return { ok: false, reasonCode: 'sequence_mismatch' };

            const decodedBytes = Math.max(0, Math.floor(input.decodedBytes));
            if (decodedBytes > direction.windowBytes) return { ok: false, reasonCode: 'receive_window_exceeded' };

            direction.nextSequence += decodedBytes;
            direction.windowBytes -= decodedBytes;
            return {
                ok: true,
                nextSequence: direction.nextSequence,
                windowBytes: direction.windowBytes,
            };
        },
        ackConsumed(input: Readonly<{
            direction: PeerTcpTunnelDirectionV1;
            decodedBytes: number;
        }>): Readonly<{ ok: true; nextSequence: number; windowBytes: number }> {
            const direction = state[input.direction];
            const decodedBytes = Math.max(0, Math.floor(input.decodedBytes));
            direction.windowBytes = Math.min(initialWindowBytes, direction.windowBytes + decodedBytes);
            return {
                ok: true,
                nextSequence: direction.nextSequence,
                windowBytes: direction.windowBytes,
            };
        },
        recordPendingAck(input: Readonly<{
            direction: PeerTcpTunnelDirectionV1;
            decodedBytes: number;
        }>): Readonly<{ pendingAckBytes: number; elapsedMs: number }> {
            const direction = state[input.direction];
            direction.pendingAckBytes += Math.max(0, Math.floor(input.decodedBytes));
            return {
                pendingAckBytes: direction.pendingAckBytes,
                elapsedMs: nowMs() - direction.lastAckMs,
            };
        },
        flushPendingAck(input: Readonly<{
            direction: PeerTcpTunnelDirectionV1;
        }>): Readonly<{ ok: true; nextSequence: number; windowBytes: number }> {
            const direction = state[input.direction];
            direction.windowBytes = Math.min(initialWindowBytes, direction.windowBytes + direction.pendingAckBytes);
            const ack = {
                ok: true as const,
                nextSequence: direction.nextSequence,
                windowBytes: direction.windowBytes,
            };
            direction.pendingAckBytes = 0;
            direction.lastAckMs = nowMs();
            return ack;
        },
        markHalfClosed(input: Readonly<{ direction: PeerTcpTunnelDirectionV1 }>): Readonly<{ ok: true }> {
            state[input.direction].halfClosed = true;
            return { ok: true };
        },
    };
}

export function createPeerTcpTunnelStreamSession(input: Readonly<{
    tunnelId: string;
    initialWindowBytes: number;
    maxFrameBytes: number;
    ackAfterBytes?: number;
    ackAfterMs?: number;
    maxIdleMs?: number;
    maxDurationMs?: number;
    maxTotalBytes?: number;
    nowMs?: () => number;
    connection: PeerTcpTunnelStreamConnection;
    sendFrame: (frame: PeerTcpTunnelFrameV1) => Promise<void> | void;
}>) {
    const nowMs = input.nowMs ?? Date.now;
    const accounting = createPeerTcpTunnelFrameAccounting({
        initialWindowBytes: input.initialWindowBytes,
        nowMs,
    });
    const sendCredit: Record<PeerTcpTunnelDirectionV1, SendCreditState> = {
        client_to_daemon: {
            nextSequence: 0,
            acknowledgedSequence: 0,
            windowBytes: input.initialWindowBytes,
        },
        daemon_to_client: {
            nextSequence: 0,
            acknowledgedSequence: 0,
            windowBytes: input.initialWindowBytes,
        },
    };
    const ackAfterBytes = Math.max(1, Math.floor(input.ackAfterBytes ?? PEER_TCP_TUNNEL_ACK_AFTER_BYTES));
    const ackAfterMs = Math.max(1, Math.floor(input.ackAfterMs ?? PEER_TCP_TUNNEL_ACK_AFTER_MS));
    const startedAtMs = nowMs();
    let lastActivityMs = startedAtMs;
    let totalBytes = 0;
    let daemonToClientSequence = 0;
    let closed = false;
    let daemonToClientHalfClosed = false;
    let daemonReadPaused = false;
    let drainingDaemonQueue = false;
    const pendingDaemonChunks: Uint8Array[] = [];
    const ackTimers: Partial<Record<PeerTcpTunnelDirectionV1, ReturnType<typeof setTimeout>>> = {};
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let durationTimer: ReturnType<typeof setTimeout> | undefined;

    function clearAckTimer(direction: PeerTcpTunnelDirectionV1): void {
        const timer = ackTimers[direction];
        if (timer) clearTimeout(timer);
        delete ackTimers[direction];
    }

    function clearAckTimers(): void {
        clearAckTimer('client_to_daemon');
        clearAckTimer('daemon_to_client');
    }

    function clearLifecycleTimers(): void {
        if (idleTimer) clearTimeout(idleTimer);
        if (durationTimer) clearTimeout(durationTimer);
        idleTimer = undefined;
        durationTimer = undefined;
    }

    async function sendAbort(reasonCode: string): Promise<void> {
        await input.sendFrame(abortFrame(input.tunnelId, reasonCode));
    }

    async function abortAndClose(reasonCode: string): Promise<void> {
        if (!closed) {
            closed = true;
            clearAckTimers();
            clearLifecycleTimers();
            pendingDaemonChunks.length = 0;
            await sendAbort(reasonCode);
            detachConnectionData?.();
            await input.connection.close();
        } else {
            await sendAbort(reasonCode);
        }
    }

    function lifecycleDenyReason(decodedBytes: number): PeerTcpTunnelStreamSessionFailure | null {
        if (closed) return { ok: false, reasonCode: 'tunnel_closed' };
        const now = nowMs();
        if (input.maxDurationMs !== undefined && now - startedAtMs > input.maxDurationMs) {
            return { ok: false, reasonCode: 'max_duration_exceeded' };
        }
        if (input.maxIdleMs !== undefined && now - lastActivityMs > input.maxIdleMs) {
            return { ok: false, reasonCode: 'max_idle_exceeded' };
        }
        if (input.maxTotalBytes !== undefined && totalBytes + decodedBytes > input.maxTotalBytes) {
            return { ok: false, reasonCode: 'total_bytes_exceeded' };
        }
        return null;
    }

    function recordActivity(decodedBytes: number): void {
        totalBytes += decodedBytes;
        lastActivityMs = nowMs();
        scheduleIdleTimer();
    }

    function scheduleIdleTimer(): void {
        if (!isSchedulableTimeoutMs(input.maxIdleMs) || closed) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
            void abortAndClose('max_idle_exceeded');
        }, input.maxIdleMs);
        idleTimer.unref?.();
    }

    function scheduleDurationTimer(): void {
        if (!isSchedulableTimeoutMs(input.maxDurationMs) || closed) return;
        durationTimer = setTimeout(() => {
            void abortAndClose('max_duration_exceeded');
        }, input.maxDurationMs);
        durationTimer.unref?.();
    }

    function availableSendWindow(direction: PeerTcpTunnelDirectionV1): number {
        const state = sendCredit[direction];
        return Math.max(0, state.acknowledgedSequence + state.windowBytes - state.nextSequence);
    }

    function applyAckFrame(frame: Extract<PeerTcpTunnelFrameV1, { kind: 'ack' }>): PeerTcpTunnelStreamSessionResult {
        const state = sendCredit[frame.direction];
        if (frame.nextSequence < state.acknowledgedSequence || frame.nextSequence > state.nextSequence) {
            return { ok: false, reasonCode: 'ack_sequence_invalid' };
        }
        state.acknowledgedSequence = frame.nextSequence;
        state.windowBytes = frame.windowBytes;
        lastActivityMs = nowMs();
        scheduleIdleTimer();
        return { ok: true };
    }

    async function sendPendingAck(direction: PeerTcpTunnelDirectionV1): Promise<void> {
        if (closed) return;
        clearAckTimer(direction);
        const ack = accounting.flushPendingAck({ direction });
        await input.sendFrame({
            v: 1,
            kind: 'ack',
            tunnelId: input.tunnelId,
            direction,
            nextSequence: ack.nextSequence,
            windowBytes: ack.windowBytes,
        });
    }

    function schedulePendingAck(direction: PeerTcpTunnelDirectionV1, elapsedMs: number): void {
        if (closed || ackTimers[direction]) return;
        const delayMs = Math.max(0, ackAfterMs - Math.max(0, elapsedMs));
        ackTimers[direction] = setTimeout(() => {
            void sendPendingAck(direction);
        }, delayMs);
    }

    async function pauseDaemonReads(): Promise<void> {
        if (daemonReadPaused || closed) return;
        daemonReadPaused = true;
        await input.connection.pauseRead?.();
    }

    async function resumeDaemonReads(): Promise<void> {
        if (!daemonReadPaused || closed || daemonToClientHalfClosed || pendingDaemonChunks.length > 0) return;
        daemonReadPaused = false;
        await input.connection.resumeRead?.();
    }

    function queueDaemonData(bytes: Uint8Array): void {
        for (let offset = 0; offset < bytes.byteLength; offset += input.maxFrameBytes) {
            pendingDaemonChunks.push(bytes.subarray(offset, offset + input.maxFrameBytes));
        }
    }

    async function sendDaemonDataFrame(bytes: Uint8Array): Promise<void> {
        const lifecycleDeny = lifecycleDenyReason(bytes.byteLength);
        if (lifecycleDeny) {
            await abortAndClose(lifecycleDeny.reasonCode);
            return;
        }
        const frame: PeerTcpTunnelFrameV1 = {
            v: 1,
            kind: 'data',
            tunnelId: input.tunnelId,
            direction: 'daemon_to_client',
            sequence: daemonToClientSequence,
            payloadBase64: encodePayloadBase64(bytes),
        };
        const caps = validatePeerTcpTunnelDataFrameCaps({
            frame,
            maxEncodedFrameBytes: input.maxFrameBytes,
            maxDecodedPayloadBytes: input.maxFrameBytes,
        });
        if (!caps.ok) {
            await abortAndClose(caps.reasonCode);
            return;
        }
        daemonToClientSequence += caps.decodedBytes;
        sendCredit.daemon_to_client.nextSequence += caps.decodedBytes;
        recordActivity(caps.decodedBytes);
        await input.sendFrame(frame);
    }

    async function drainDaemonQueue(): Promise<void> {
        if (drainingDaemonQueue) return;
        drainingDaemonQueue = true;
        try {
            while (!closed && !daemonToClientHalfClosed && pendingDaemonChunks.length > 0) {
                const next = pendingDaemonChunks[0]!;
                if (next.byteLength > availableSendWindow('daemon_to_client')) {
                    await pauseDaemonReads();
                    return;
                }
                pendingDaemonChunks.shift();
                await sendDaemonDataFrame(next);
            }
            await resumeDaemonReads();
        } finally {
            drainingDaemonQueue = false;
        }
    }

    async function enqueueDaemonData(bytes: Uint8Array): Promise<void> {
        if (closed || daemonToClientHalfClosed || bytes.byteLength === 0) return;
        queueDaemonData(bytes);
        await drainDaemonQueue();
    }

    let detachConnectionData: (() => void) | void;
    detachConnectionData = input.connection.onData?.((bytes) => {
        return enqueueDaemonData(bytes);
    });

    async function closeConnection(): Promise<void> {
        closed = true;
        clearAckTimers();
        clearLifecycleTimers();
        pendingDaemonChunks.length = 0;
        detachConnectionData?.();
        await input.connection.close();
    }

    scheduleIdleTimer();
    scheduleDurationTimer();

    return {
        async acceptFrame(raw: unknown): Promise<PeerTcpTunnelStreamSessionResult> {
            const parsed = PeerTcpTunnelFrameV1Schema.safeParse(raw);
            if (!parsed.success) {
                await sendAbort('frame_invalid');
                return { ok: false, reasonCode: 'frame_invalid' };
            }

            const frame = parsed.data;
            const frameTunnelId = frame.kind === 'open' ? frame.open.tunnelId : frame.tunnelId;
            if (frameTunnelId !== input.tunnelId) {
                await sendAbort('tunnel_id_mismatch');
                return { ok: false, reasonCode: 'tunnel_id_mismatch' };
            }

            if (frame.kind === 'data') {
                if (frame.direction !== 'client_to_daemon') {
                    await sendAbort('direction_not_allowed');
                    return { ok: false, reasonCode: 'direction_not_allowed' };
                }

                const caps = validatePeerTcpTunnelDataFrameCaps({
                    frame,
                    maxEncodedFrameBytes: input.maxFrameBytes,
                    maxDecodedPayloadBytes: input.maxFrameBytes,
                });
                if (!caps.ok) {
                    await sendAbort(caps.reasonCode);
                    return { ok: false, reasonCode: caps.reasonCode };
                }

                const lifecycleDeny = lifecycleDenyReason(caps.decodedBytes);
                if (lifecycleDeny) {
                    await abortAndClose(lifecycleDeny.reasonCode);
                    return lifecycleDeny;
                }

                const accepted = accounting.acceptData({
                    direction: frame.direction,
                    sequence: frame.sequence,
                    decodedBytes: caps.decodedBytes,
                });
                if (!accepted.ok) {
                    await sendAbort(accepted.reasonCode);
                    return accepted;
                }

                if (frame.direction === 'client_to_daemon') {
                    await input.connection.write?.(decodePayloadBase64(frame.payloadBase64));
                    recordActivity(caps.decodedBytes);
                    const pendingAck = accounting.recordPendingAck({
                        direction: frame.direction,
                        decodedBytes: caps.decodedBytes,
                    });
                    if (pendingAck.pendingAckBytes >= ackAfterBytes || pendingAck.elapsedMs >= ackAfterMs) {
                        await sendPendingAck(frame.direction);
                    } else {
                        schedulePendingAck(frame.direction, pendingAck.elapsedMs);
                    }
                }

                return { ok: true };
            }

            if (frame.kind === 'ack') {
                const ack = applyAckFrame(frame);
                if (!ack.ok) {
                    await sendAbort(ack.reasonCode);
                }
                if (ack.ok && frame.direction === 'daemon_to_client') {
                    await drainDaemonQueue();
                }
                return ack;
            }

            if (frame.kind === 'close') {
                if (frame.halfClose && frame.direction) {
                    accounting.markHalfClosed({ direction: frame.direction });
                    if (frame.direction === 'client_to_daemon') {
                        await input.connection.endWrite?.();
                    } else {
                        daemonToClientHalfClosed = true;
                        pendingDaemonChunks.length = 0;
                        await pauseDaemonReads();
                    }
                    return { ok: true };
                }
                await closeConnection();
                return { ok: true };
            }

            if (frame.kind === 'abort') {
                await closeConnection();
                return { ok: true };
            }

            return { ok: true };
        },
    };
}
