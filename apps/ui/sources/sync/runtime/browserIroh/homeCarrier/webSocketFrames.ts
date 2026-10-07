import { EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES } from '@happier-dev/protocol/actions/externalActionApi';

/**
 * RFC 6455 framing for the browser Iroh Home carrier (Lane 06 amendment A7.3).
 *
 * A browser cannot ask its own WebSocket stack to run over an Iroh stream, so
 * the carrier speaks the wire protocol itself. This module owns only frames:
 * message assembly, the closing handshake, and the transport lifecycle belong
 * to `homeTunnelWebSocket`.
 *
 * Client frames are always masked with bytes from the host's secure random
 * source, and a server frame that arrives masked is a protocol violation. That
 * asymmetry is the specification's, not a policy invented here.
 */

export const WEB_SOCKET_MAX_CONTROL_FRAME_PAYLOAD_BYTES = 125;
export const WEB_SOCKET_MASK_BYTES = 4;
export const WEB_SOCKET_MAX_MESSAGE_PAYLOAD_BYTES = EXTERNAL_ACTION_RELAY_REQUEST_SOCKET_MIN_BUFFER_BYTES;

export const WEB_SOCKET_OPCODE = {
    continuation: 0x0,
    text: 0x1,
    binary: 0x2,
    close: 0x8,
    ping: 0x9,
    pong: 0xa,
} as const;

export type WebSocketOpcode = (typeof WEB_SOCKET_OPCODE)[keyof typeof WEB_SOCKET_OPCODE];

/** The subset of RFC 6455 §7.4.1 status codes this carrier originates or reports. */
export const WEB_SOCKET_CLOSE_CODE = {
    normal: 1000,
    goingAway: 1001,
    protocolError: 1002,
    noStatus: 1005,
    abnormal: 1006,
    invalidPayload: 1007,
    messageTooBig: 1009,
} as const;

/** A wire-level violation. `closeCode` is the status the peer should be told. */
export class WebSocketProtocolError extends Error {
    constructor(readonly closeCode: number, message: string) {
        super(message);
        this.name = 'WebSocketProtocolError';
    }
}

export type WebSocketFrame = Readonly<{
    fin: boolean;
    opcode: WebSocketOpcode;
    payload: Uint8Array;
}>;

export function isWebSocketControlOpcode(opcode: number): boolean {
    return (opcode & 0x08) !== 0;
}

/**
 * Masking is a security property of the protocol, not a formality: a
 * predictable mask is what makes proxy cache poisoning possible. A host without
 * a secure random source therefore fails closed instead of degrading.
 */
export function secureWebSocketMask(): Uint8Array {
    const source = globalThis.crypto;
    if (source === undefined || typeof source.getRandomValues !== 'function') {
        throw new Error('Masking a WebSocket frame requires a secure random source');
    }
    return source.getRandomValues(new Uint8Array(WEB_SOCKET_MASK_BYTES));
}

export function encodeMaskedClientFrame(
    opcode: WebSocketOpcode,
    payload: Uint8Array,
    mask: Uint8Array = secureWebSocketMask(),
): Uint8Array {
    if (mask.length !== WEB_SOCKET_MASK_BYTES) {
        throw new Error(`A WebSocket mask is ${WEB_SOCKET_MASK_BYTES} bytes`);
    }
    if (isWebSocketControlOpcode(opcode) && payload.length > WEB_SOCKET_MAX_CONTROL_FRAME_PAYLOAD_BYTES) {
        throw new WebSocketProtocolError(
            WEB_SOCKET_CLOSE_CODE.protocolError,
            `A control frame carries at most ${WEB_SOCKET_MAX_CONTROL_FRAME_PAYLOAD_BYTES} bytes`,
        );
    }

    const length = payload.length;
    const headerBytes = length < 126 ? 2 : length < 0x1_0000 ? 4 : 10;
    const frame = new Uint8Array(headerBytes + WEB_SOCKET_MASK_BYTES + length);
    const view = new DataView(frame.buffer);

    frame[0] = 0x80 | opcode;
    if (length < 126) {
        frame[1] = 0x80 | length;
    } else if (length < 0x1_0000) {
        frame[1] = 0x80 | 126;
        view.setUint16(2, length);
    } else {
        frame[1] = 0x80 | 127;
        view.setBigUint64(2, BigInt(length));
    }

    frame.set(mask, headerBytes);
    const payloadOffset = headerBytes + WEB_SOCKET_MASK_BYTES;
    for (let index = 0; index < length; index += 1) {
        frame[payloadOffset + index] = (payload[index] as number) ^ (mask[index % WEB_SOCKET_MASK_BYTES] as number);
    }
    return frame;
}

function isKnownOpcode(opcode: number): opcode is WebSocketOpcode {
    return opcode === 0x0 || opcode === 0x1 || opcode === 0x2 || opcode === 0x8 || opcode === 0x9 || opcode === 0xa;
}

class ByteQueue {
    private chunks: Uint8Array[] = [];
    private headIndex = 0;
    private headOffset = 0;
    length = 0;

    push(chunk: Uint8Array): void {
        if (chunk.length === 0) return;
        this.chunks.push(chunk);
        this.length += chunk.length;
    }

    byteAt(index: number): number {
        let remaining = this.headOffset + index;
        for (let chunkIndex = this.headIndex; chunkIndex < this.chunks.length; chunkIndex += 1) {
            const chunk = this.chunks[chunkIndex] as Uint8Array;
            if (remaining < chunk.length) return chunk[remaining] as number;
            remaining -= chunk.length;
        }
        throw new RangeError('WebSocket byte offset is outside buffered data');
    }

    take(length: number): Uint8Array {
        const result = new Uint8Array(length);
        let written = 0;
        while (written < length) {
            const chunk = this.chunks[this.headIndex] as Uint8Array;
            const available = chunk.length - this.headOffset;
            const count = Math.min(available, length - written);
            result.set(chunk.subarray(this.headOffset, this.headOffset + count), written);
            written += count;
            this.headOffset += count;
            this.length -= count;
            if (this.headOffset === chunk.length) {
                this.headIndex += 1;
                this.headOffset = 0;
            }
        }
        if (this.headIndex === this.chunks.length) {
            this.chunks = [];
            this.headIndex = 0;
        }
        return result;
    }

    discard(length: number): void {
        this.take(length);
    }

    clear(): void {
        this.chunks = [];
        this.headIndex = 0;
        this.headOffset = 0;
        this.length = 0;
    }
}

/**
 * Incremental server-frame decoder. Iroh reads deliver arbitrary byte runs, so
 * a frame may span reads and a read may carry several frames; the decoder holds
 * the remainder and yields only whole frames.
 *
 * Extended lengths are accepted as sent. Minimal-length encoding is not
 * enforced, because rejecting a legal-but-verbose length would only break
 * interoperability with a compliant Home for no safety gain.
 */
export class WebSocketFrameDecoder {
    private readonly buffer = new ByteQueue();
    private fragmentOpcode: WebSocketOpcode | null = null;
    private fragments: Uint8Array[] = [];
    private fragmentBytes = 0;

    push(chunk: Uint8Array): WebSocketFrame[] {
        this.buffer.push(chunk);
        const frames: WebSocketFrame[] = [];
        try {
          for (;;) {
            const available = this.buffer.length;
            if (available < 2) break;

            const first = this.buffer.byteAt(0);
            const second = this.buffer.byteAt(1);

            if ((first & 0x70) !== 0) {
                throw new WebSocketProtocolError(
                    WEB_SOCKET_CLOSE_CODE.protocolError,
                    'Home set a reserved WebSocket frame bit without a negotiated extension',
                );
            }
            const opcode = first & 0x0f;
            if (!isKnownOpcode(opcode)) {
                throw new WebSocketProtocolError(
                    WEB_SOCKET_CLOSE_CODE.protocolError,
                    `Home sent an unknown WebSocket opcode 0x${opcode.toString(16)}`,
                );
            }
            if ((second & 0x80) !== 0) {
                throw new WebSocketProtocolError(
                    WEB_SOCKET_CLOSE_CODE.protocolError,
                    'Home masked a server-to-client WebSocket frame',
                );
            }

            const fin = (first & 0x80) !== 0;
            const indicator = second & 0x7f;
            let headerBytes = 2;
            let length = indicator;
            if (indicator === 126) {
                if (available < 4) break;
                length = (this.buffer.byteAt(2) << 8) | this.buffer.byteAt(3);
                headerBytes = 4;
            } else if (indicator === 127) {
                if (available < 10) break;
                let extended = 0n;
                for (let index = 2; index < 10; index += 1) extended = (extended << 8n) | BigInt(this.buffer.byteAt(index));
                if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
                    throw new WebSocketProtocolError(
                        WEB_SOCKET_CLOSE_CODE.messageTooBig,
                        'Home announced a WebSocket frame larger than this runtime can address',
                    );
                }
                length = Number(extended);
                headerBytes = 10;
            }

            if (!isWebSocketControlOpcode(opcode) && length > WEB_SOCKET_MAX_MESSAGE_PAYLOAD_BYTES) {
                throw new WebSocketProtocolError(
                    WEB_SOCKET_CLOSE_CODE.messageTooBig,
                    `Home announced a WebSocket message above the ${WEB_SOCKET_MAX_MESSAGE_PAYLOAD_BYTES}-byte limit`,
                );
            }

            if (isWebSocketControlOpcode(opcode)) {
                if (!fin) {
                    throw new WebSocketProtocolError(
                        WEB_SOCKET_CLOSE_CODE.protocolError,
                        'Home fragmented a WebSocket control frame',
                    );
                }
                if (length > WEB_SOCKET_MAX_CONTROL_FRAME_PAYLOAD_BYTES) {
                    throw new WebSocketProtocolError(
                        WEB_SOCKET_CLOSE_CODE.protocolError,
                        `Home sent a control frame of ${length} bytes, above the ${WEB_SOCKET_MAX_CONTROL_FRAME_PAYLOAD_BYTES}-byte limit`,
                    );
                }
            }

            if (available < headerBytes + length) break;
            this.buffer.discard(headerBytes);
            const frame = { fin, opcode, payload: this.buffer.take(length) };
            const assembled = this.assemble(frame);
            if (assembled !== null) frames.push(assembled);
          }
          return frames;
        } catch (error) {
            this.buffer.clear();
            this.clearFragments();
            throw error;
        }
    }

    private assemble(frame: WebSocketFrame): WebSocketFrame | null {
        if (isWebSocketControlOpcode(frame.opcode)) return frame;
        if (frame.opcode === WEB_SOCKET_OPCODE.continuation) {
            if (this.fragmentOpcode === null) {
                throw new WebSocketProtocolError(WEB_SOCKET_CLOSE_CODE.protocolError, 'Home sent a continuation frame without a started message');
            }
            this.retainFragment(frame.payload);
            if (!frame.fin) return null;
            const payload = new Uint8Array(this.fragmentBytes);
            let offset = 0;
            for (const fragment of this.fragments) {
                payload.set(fragment, offset);
                offset += fragment.length;
            }
            const opcode = this.fragmentOpcode;
            this.clearFragments();
            return { fin: true, opcode, payload };
        }
        if (this.fragmentOpcode !== null) {
            throw new WebSocketProtocolError(WEB_SOCKET_CLOSE_CODE.protocolError, 'Home started a new data frame inside a fragmented message');
        }
        if (frame.fin) return frame;
        this.fragmentOpcode = frame.opcode;
        this.retainFragment(frame.payload);
        return null;
    }

    private retainFragment(payload: Uint8Array): void {
        if (payload.length > WEB_SOCKET_MAX_MESSAGE_PAYLOAD_BYTES - this.fragmentBytes) {
            throw new WebSocketProtocolError(WEB_SOCKET_CLOSE_CODE.messageTooBig, `Home sent a fragmented WebSocket message above the ${WEB_SOCKET_MAX_MESSAGE_PAYLOAD_BYTES}-byte limit`);
        }
        this.fragments.push(payload);
        this.fragmentBytes += payload.length;
    }

    private clearFragments(): void {
        this.fragmentOpcode = null;
        this.fragments = [];
        this.fragmentBytes = 0;
    }
}
