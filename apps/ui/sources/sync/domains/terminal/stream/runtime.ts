import type {
    EmbeddedTerminalRendererHandle,
    EmbeddedTerminalWriteBytesResult,
    EmbeddedTerminalWriteCompleteEvent,
} from '@/components/terminal/embedded/embeddedTerminalRendererHandle';

import type {
    TerminalStreamFrame,
    TerminalStreamGapFrame,
    TerminalStreamUrlFrame,
} from './model';

export type TerminalStreamRuntimeStatus = 'active' | 'exited';

export type TerminalStreamRuntime = Readonly<{
    applyFrames: (frames: readonly TerminalStreamFrame[]) => Readonly<{
        status: TerminalStreamRuntimeStatus;
        acceptedByteOffset: number | null;
        rejectedByteOffset: number | null;
        queuedWrite: EmbeddedTerminalWriteCompleteEvent | null;
        deferredFrames?: readonly TerminalStreamFrame[];
    }>;
}>;

export type TerminalUtf8ProjectionDecoder = Readonly<{
    decode: (bytes: Uint8Array) => string;
    flush: () => string;
    reset: () => void;
}>;

export function createTerminalUtf8ProjectionDecoder(): TerminalUtf8ProjectionDecoder {
    let decoder = new TextDecoder();

    return {
        decode: (bytes) => decoder.decode(bytes, { stream: true }),
        flush: () => {
            const output = decoder.decode();
            decoder = new TextDecoder();
            return output;
        },
        reset: () => {
            decoder = new TextDecoder();
        },
    };
}

export function createTerminalStreamRuntime(input: Readonly<{
    terminalId: string;
    rendererId: string;
    renderer: EmbeddedTerminalRendererHandle;
    surfaceEpoch: number;
    onGap?: (frame: TerminalStreamGapFrame) => void;
    onUrl?: (frame: TerminalStreamUrlFrame) => void;
    onExit?: (frame: Extract<TerminalStreamFrame, { t: 'exit' }>) => void;
}>): TerminalStreamRuntime {
    const fallbackDecoder = createTerminalUtf8ProjectionDecoder();

    return {
        applyFrames: (frames) => {
            let status: TerminalStreamRuntimeStatus = 'active';
            let acceptedByteOffset: number | null = null;
            let rejectedByteOffset: number | null = null;
            let queuedWrite: EmbeddedTerminalWriteCompleteEvent | null = null;
            let deferredFrames: readonly TerminalStreamFrame[] | undefined;
            for (let index = 0; index < frames.length; index += 1) {
                const frame = frames[index]!;
                if (frame.terminalId !== input.terminalId) {
                    continue;
                }
                if (frame.t === 'bytes') {
                    if (input.renderer.writeBytes) {
                        const accepted = input.renderer.writeBytes({
                            terminalId: frame.terminalId,
                            seq: frame.seq,
                            byteOffset: frame.byteOffset,
                            writeGeneration: input.surfaceEpoch,
                            bytes: frame.bytes,
                        });
                        if (accepted === false) {
                            rejectedByteOffset = frame.byteOffset;
                            break;
                        }
                        if (isQueuedWriteResult(accepted)) {
                            queuedWrite = {
                                terminalId: frame.terminalId,
                                seq: frame.seq,
                                byteOffset: frame.byteOffset,
                                byteLength: frame.byteLength,
                                ackedByteOffset: frame.byteOffset + frame.byteLength,
                                writeGeneration: input.surfaceEpoch,
                            };
                            deferredFrames = frames.slice(index + 1);
                            break;
                        }
                    } else {
                        const decoded = fallbackDecoder.decode(frame.bytes);
                        if (decoded) {
                            const accepted = input.renderer.write(decoded);
                            if (accepted === false) {
                                rejectedByteOffset = frame.byteOffset;
                                break;
                            }
                        }
                    }
                    acceptedByteOffset = frame.byteOffset + frame.byteLength;
                    continue;
                }
                if (frame.t === 'gap') {
                    fallbackDecoder.reset();
                    input.onGap?.(frame);
                    continue;
                }
                if (frame.t === 'url') {
                    input.onUrl?.(frame);
                    continue;
                }
                const pendingText = fallbackDecoder.flush();
                if (pendingText) {
                    const accepted = input.renderer.write(pendingText);
                    if (accepted === false) {
                        break;
                    }
                }
                input.onExit?.(frame);
                status = 'exited';
            }
            return {
                status,
                acceptedByteOffset,
                rejectedByteOffset,
                queuedWrite,
                ...(deferredFrames === undefined ? {} : { deferredFrames }),
            };
        },
    };
}

function isQueuedWriteResult(result: EmbeddedTerminalWriteBytesResult): result is Readonly<{ status: 'queued' }> {
    return typeof result === 'object' && result !== null && result.status === 'queued';
}
