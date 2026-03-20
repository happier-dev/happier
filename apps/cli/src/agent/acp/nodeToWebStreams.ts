import type { Readable, Writable } from 'node:stream';
import { createWriteStream, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger } from '@/ui/logger';

/**
 * Convert Node.js streams to Web Streams for ACP SDK.
 */
export function nodeToWebStreams(
    stdin: Writable,
    stdout: Readable,
): { writable: WritableStream<Uint8Array>; readable: ReadableStream<Uint8Array> } {
    const isBenignWriteError = (error: unknown): boolean => {
        const e = error as { code?: unknown; message?: unknown };
        const code = typeof e?.code === 'string' ? e.code : '';
        const message = typeof e?.message === 'string' ? e.message : '';
        // Normal shutdown / race conditions can surface as EPIPE or destroyed stream writes.
        return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' || /stream was destroyed/i.test(message);
    };

    const isTruthyEnv = (value: string | undefined): boolean => {
        const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
        return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
    };

    const safeCloseCapture = (stream: WriteStream | undefined): void => {
        try {
            stream?.end();
        } catch {
            // ignore
        }
    };

    const capture = (() => {
        if (!isTruthyEnv(process.env.HAPPIER_ACP_CAPTURE_IO)) return null;
        const traceFile = (process.env.HAPPIER_STACK_TOOL_TRACE_FILE ?? '').toString().trim();
        const baseDir = traceFile ? dirname(traceFile) : process.cwd();
        const withCaptureErrorHandler = (stream: WriteStream, streamLabel: 'stdin' | 'stdout'): WriteStream => {
            stream.on('error', (error) => {
                logger.debug(`[nodeToWebStreams] Ignoring ACP ${streamLabel} capture stream error`, error);
            });
            return stream;
        };
        let rawStdin: WriteStream | undefined;
        let rawStdout: WriteStream | undefined;
        try {
            const stdinPath = join(baseDir, 'acp.stdin.raw');
            const stdoutPath = join(baseDir, 'acp.stdout.raw');
            rawStdin = createWriteStream(stdinPath, { flags: 'a' });
            rawStdout = createWriteStream(stdoutPath, { flags: 'a' });
            return {
                stdinStream: withCaptureErrorHandler(rawStdin, 'stdin'),
                stdoutStream: withCaptureErrorHandler(rawStdout, 'stdout'),
            } as const;
        } catch (error) {
            safeCloseCapture(rawStdin);
            safeCloseCapture(rawStdout);
            logger.debug('[nodeToWebStreams] Failed to set up ACP IO capture', error);
            return null;
        }
    })();

    let activeStdinWriteErrorHandler: ((error: unknown) => void) | null = null;
    const onStdinError = (error: unknown): void => {
        if (activeStdinWriteErrorHandler) {
            activeStdinWriteErrorHandler(error);
            return;
        }
        if (isBenignWriteError(error)) {
            return;
        }
        logger.debug(`[nodeToWebStreams] stdin stream error without active write`, error);
    };
    stdin.on('error', onStdinError);

    const writeChunk = (chunk: Uint8Array) => {
            try {
                capture?.stdinStream.write(Buffer.from(chunk));
            } catch {
                // ignore capture failures
            }
            return new Promise<void>((resolve, reject) => {
                let drained = false;
                let wrote = false;
                let settled = false;
                const clearActiveWriteErrorHandler = () => {
                    if (activeStdinWriteErrorHandler === onWriteError) {
                        activeStdinWriteErrorHandler = null;
                    }
                };

                const onWriteError = (error: unknown) => {
                    if (settled) return;
                    settled = true;
                    stdin.off('drain', onDrain);
                    clearActiveWriteErrorHandler();
                    if (isBenignWriteError(error)) {
                        resolve();
                        return;
                    }
                    logger.debug(`[nodeToWebStreams] Error writing to stdin:`, error);
                    if (error instanceof Error) {
                        reject(error);
                        return;
                    }
                    reject(new Error(String(error)));
                };
                activeStdinWriteErrorHandler = onWriteError;

                const onDrain = () => {
                    drained = true;
                    if (!wrote) return;
                    if (settled) return;
                    settled = true;
                    stdin.off('drain', onDrain);
                    clearActiveWriteErrorHandler();
                    resolve();
                };

                // Register the drain handler up-front to avoid missing a synchronous `drain` emission
                // from custom Writable implementations (or odd edge cases).
                stdin.once('drain', onDrain);

                const ok = stdin.write(chunk, (err) => {
                    wrote = true;
                    if (err) {
                        onWriteError(err);
                        return;
                    }

                    if (ok) {
                        if (!settled) {
                            settled = true;
                            stdin.off('drain', onDrain);
                            clearActiveWriteErrorHandler();
                            resolve();
                        }
                        return;
                    }

                    if (drained && !settled) {
                        settled = true;
                        stdin.off('drain', onDrain);
                        clearActiveWriteErrorHandler();
                        resolve();
                    }
                });

                drained = drained || ok;
                if (ok) {
                    // No drain will be emitted for this write; remove the listener immediately.
                    stdin.off('drain', onDrain);
                }
            });
        };

    const closeWritable = () => {
            return new Promise<void>((resolve) => {
                safeCloseCapture(capture?.stdinStream);
                stdin.off('error', onStdinError);
                stdin.end(resolve);
            });
        };

    const abortWritable = (reason: unknown) => {
            safeCloseCapture(capture?.stdinStream);
            stdin.off('error', onStdinError);
            stdin.destroy(reason instanceof Error ? reason : new Error(String(reason)));
        };

    const writer = {
        write: writeChunk,
        close: closeWritable,
        abort: abortWritable,
        releaseLock() {
            // Intentionally a no-op. Some packaged runtimes do not reliably support
            // reacquiring a new Web writer for every ACP frame, so we keep one stable
            // facade bound to the same underlying stdin bridge.
        },
        get closed() {
            return Promise.resolve(undefined);
        },
        get desiredSize() {
            return null;
        },
        get ready() {
            return Promise.resolve(undefined);
        },
    } as WritableStreamDefaultWriter<Uint8Array>;

    const writable = {
        getWriter() {
            return writer;
        },
        get locked() {
            return false;
        },
        abort: abortWritable,
        close: closeWritable,
    } as unknown as WritableStream<Uint8Array>;

    let cancelStdout: (() => void) | null = null;

    const readable = new ReadableStream<Uint8Array>({
        // Keep handler refs in the underlying source closure so cancel() can remove them and avoid
        // double-closing the controller when stdout emits 'end' after a destroy().
        // (This can happen when consumers cancel reads early.)
        start(controller) {
            let closed = false;
            let cancelled = false;

            const onData = (chunk: Buffer) => {
                if (cancelled) return;
                try {
                    capture?.stdoutStream.write(chunk);
                } catch {
                    // ignore capture failures
                }
                if (closed) return;
                controller.enqueue(new Uint8Array(chunk));
            };

            const onEnd = () => {
                if (cancelled) return;
                if (closed) return;
                closed = true;
                safeCloseCapture(capture?.stdoutStream);
                try {
                    controller.close();
                } catch {
                    // ignore double-close
                }
            };

            const onError = (err: unknown) => {
                if (cancelled) return;
                logger.debug(`[nodeToWebStreams] Stdout error:`, err);
                if (closed) return;
                closed = true;
                safeCloseCapture(capture?.stdoutStream);
                try {
                    controller.error(err);
                } catch {
                    // ignore
                }
            };

            stdout.on('data', onData);
            stdout.on('end', onEnd);
            stdout.on('error', onError);

            cancelStdout = () => {
                cancelled = true;
                closed = true;
                safeCloseCapture(capture?.stdoutStream);
                stdout.off('data', onData);
                stdout.off('end', onEnd);
                stdout.off('error', onError);
            };
        },
        cancel() {
            try {
                cancelStdout?.();
            } catch {
                // ignore
            }
            stdout.destroy();
        },
    });

    return { writable, readable };
}
