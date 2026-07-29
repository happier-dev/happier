export type EmbeddedTerminalWriteCompleteEvent = Readonly<{
    terminalId: string;
    seq: number;
    byteOffset: number;
    byteLength: number;
    ackedByteOffset: number;
}>;

export type EmbeddedTerminalWriteBytesResult =
    | boolean
    | void
    | Readonly<{ status: 'queued' }>;

export type EmbeddedTerminalRendererHandle = Readonly<{
    write: (data: string) => boolean | void;
    writeBytes?: (input: Readonly<{
        terminalId: string;
        seq: number;
        byteOffset: number;
        bytes: Uint8Array;
    }>) => EmbeddedTerminalWriteBytesResult;
    clear: () => void;
    focus?: () => void;
    hasSelection?: () => boolean;
    getSelectionText?: () => string;
}>;
