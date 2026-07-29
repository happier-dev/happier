import type {
    DaemonTerminalStreamEventUrl,
    DaemonTerminalStreamReadResponse,
} from '@happier-dev/protocol';

export type TerminalStreamCursor = Readonly<{
    mode: 'byte-offset' | 'legacy-event-cursor';
    value: number;
}>;

export type TerminalStreamBytesFrame = Readonly<{
    t: 'bytes';
    terminalId: string;
    seq: number;
    byteOffset: number;
    byteLength: number;
    bytes: Uint8Array;
    source: 'byte-stream' | 'legacy-string';
}>;

export type TerminalStreamGapFrame = Readonly<{
    t: 'gap';
    terminalId: string;
    droppedBefore: number;
    reason: 'ring_overflow' | 'consumer_too_slow' | 'session_restarted' | 'legacy_event_gap';
}>;

export type TerminalStreamUrlFrame = DaemonTerminalStreamEventUrl & Readonly<{
    terminalId: string;
    byteOffset: number;
}>;

export type TerminalStreamExitFrame = Readonly<{
    t: 'exit';
    terminalId: string;
    byteOffset: number;
    exitCode: number | null;
    signal: number | null;
}>;

export type TerminalStreamFrame =
    | TerminalStreamBytesFrame
    | TerminalStreamGapFrame
    | TerminalStreamUrlFrame
    | TerminalStreamExitFrame;

export type TerminalStreamReadRequest = Readonly<{
    terminalId: string;
    cursor: TerminalStreamCursor;
    ackedByteOffset?: number;
    creditBytes?: number;
    maxBytes?: number;
    maxFrames?: number;
    rendererId?: string;
    surfaceEpoch?: number;
}>;

export type TerminalStreamReadResponse =
    | Readonly<{
        ok: true;
        terminalId: string;
        mode: TerminalStreamCursor['mode'];
        frames: readonly TerminalStreamFrame[];
        nextCursor: number;
        done: boolean;
        legacyResponse?: DaemonTerminalStreamReadResponse;
    }>
    | Readonly<{
        ok: false;
        code: string;
        message: string;
    }>;

export type TerminalRendererAck = Readonly<{
    terminalId: string;
    rendererId: string;
    surfaceEpoch: number;
    ackedByteOffset: number;
    creditBytes: number;
}>;

export type TerminalInputEvent =
    | Readonly<{ t: 'text'; text: string }>
    | Readonly<{ t: 'key'; key: string; modifiers: readonly ('shift' | 'ctrl' | 'alt' | 'meta')[] }>
    | Readonly<{ t: 'paste'; text: string; bracketed: boolean }>
    | Readonly<{ t: 'ime'; phase: 'start' | 'update' | 'commit' | 'cancel'; text?: string }>
    | Readonly<{ t: 'mouse'; kind: 'down' | 'up' | 'move' | 'wheel'; button?: number; x: number; y: number; modifiers: readonly string[] }>
    | Readonly<{ t: 'resize'; cols: number; rows: number }>;

export type TerminalStreamCarrier = Readonly<{
    kind: 'machine-rpc-base64';
    read: (request: TerminalStreamReadRequest) => Promise<TerminalStreamReadResponse>;
    acknowledge: (ack: TerminalRendererAck) => Promise<void>;
    sendInput: (terminalId: string, event: TerminalInputEvent) => Promise<void>;
}>;
