import type {
    DaemonTerminalStreamReadResponse,
    TerminalStreamReadResponse as ProtocolTerminalStreamReadResponse,
} from '@happier-dev/protocol';

import { decodeBase64 } from '@/encryption/base64';

import type {
    TerminalStreamBytesFrame,
    TerminalStreamFrame,
    TerminalStreamReadResponse,
} from './model';

const utf8Encoder = new TextEncoder();

export type TerminalBase64BytesFrameInput = Readonly<{
    t: 'bytes';
    terminalId: string;
    seq: number;
    byteOffset: number;
    byteLength: number;
    encoding: 'base64';
    data: string;
}>;

export function mapTerminalBytesFrame(frame: TerminalBase64BytesFrameInput): TerminalStreamBytesFrame {
    const bytes = decodeBase64(frame.data, 'base64');
    if (bytes.byteLength !== frame.byteLength) {
        throw new Error(`Terminal byte frame byteLength mismatch: expected ${frame.byteLength}, decoded ${bytes.byteLength}`);
    }

    return {
        t: 'bytes',
        terminalId: frame.terminalId,
        seq: frame.seq,
        byteOffset: frame.byteOffset,
        byteLength: frame.byteLength,
        bytes,
        source: 'byte-stream',
    };
}

export function mapLegacyTerminalReadResponse(input: Readonly<{
    terminalId: string;
    cursor: number;
    response: DaemonTerminalStreamReadResponse;
}>): TerminalStreamReadResponse {
    if (!input.response.ok) {
        return {
            ok: false,
            code: input.response.errorCode,
            message: input.response.error,
        };
    }

    const terminalId = input.terminalId;
    let byteOffset = input.cursor;
    const frames: TerminalStreamFrame[] = input.response.events.map((event, index): TerminalStreamFrame => {
        if (event.t === 'data') {
            const bytes = utf8Encoder.encode(event.data);
            const frame: TerminalStreamBytesFrame = {
                t: 'bytes',
                terminalId,
                seq: input.cursor + index,
                byteOffset,
                byteLength: bytes.byteLength,
                bytes,
                source: 'legacy-string',
            };
            byteOffset += bytes.byteLength;
            return frame;
        }
        if (event.t === 'gap') {
            return {
                t: 'gap',
                terminalId,
                droppedBefore: event.droppedBefore,
                reason: 'legacy_event_gap',
            } as const;
        }
        if (event.t === 'url') {
            return {
                ...event,
                terminalId,
                byteOffset,
            } as const;
        }
        return {
            ...event,
            terminalId,
            byteOffset,
        } as const;
    });

    return {
        ok: true,
        terminalId,
        mode: 'legacy-event-cursor',
        frames,
        nextCursor: input.response.nextCursor,
        done: input.response.done,
        legacyResponse: input.response,
    };
}

export function terminalByteStreamReadRequiresLegacyFallback(response: ProtocolTerminalStreamReadResponse): boolean {
    return (
        (!response.ok && response.code === 'terminal_byte_stream_unavailable')
        || (response.ok && response.frames.some((frame) => frame.t === 'legacyOnly'))
    );
}

export function mapTerminalByteStreamReadResponse(response: ProtocolTerminalStreamReadResponse): TerminalStreamReadResponse {
    if (!response.ok) {
        return {
            ok: false,
            code: response.code,
            message: response.message,
        };
    }

    const frames: TerminalStreamFrame[] = [];
    for (const frame of response.frames) {
        if (frame.t === 'bytes') {
            frames.push(mapTerminalBytesFrame(frame));
            continue;
        }
        if (frame.t === 'gap') {
            frames.push({
                t: 'gap',
                terminalId: frame.terminalId,
                droppedBefore: frame.droppedBeforeByteOffset,
                reason: frame.reason,
            });
            continue;
        }
        if (frame.t === 'url') {
            frames.push({
                t: 'url',
                terminalId: frame.terminalId,
                byteOffset: frame.byteOffset,
                url: frame.url,
                kind: frame.kind,
                suggestOpen: frame.suggestOpen,
            });
            continue;
        }
        if (frame.t === 'exit') {
            frames.push({
                t: 'exit',
                terminalId: frame.terminalId,
                byteOffset: frame.byteOffset,
                exitCode: frame.exitCode,
                signal: frame.signal,
            });
        }
    }

    return {
        ok: true,
        terminalId: response.terminalId,
        mode: 'byte-offset',
        frames,
        nextCursor: response.nextByteOffset,
        done: response.done,
    };
}
