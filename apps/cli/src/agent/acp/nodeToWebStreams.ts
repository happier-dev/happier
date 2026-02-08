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

    const writable = new WritableStream<Uint8Array>({
        write(chunk) {
            try {
                capture?.stdinStream.write(Buffer.from(chunk));
            } catch {
                // ignore capture failures
            }
            return new Promise((resolve, reject) => {
                let drained = false;
                let wrote = false;
                let settled = false;

                const onDrain = () => {
                    drained = true;
                    if (!wrote) return;
                    if (settled) return;
                    settled = true;
                    stdin.off('drain', onDrain);
                    resolve();
                };

                // Register the drain handler up-front to avoid missing a synchronous `drain` emission
                // from custom Writable implementations (or odd edge cases).
                stdin.once('drain', onDrain);

                const ok = stdin.write(chunk, (err) => {
                    wrote = true;
                    if (err) {
                        logger.debug(`[nodeToWebStreams] Error writing to stdin:`, err);
                        if (!settled) {
                            settled = true;
                            stdin.off('drain', onDrain);
                            reject(err);
                        }
                        return;
                    }

                    if (ok) {
                        if (!settled) {
                            settled = true;
                            stdin.off('drain', onDrain);
                            resolve();
                        }
                        return;
                    }

                    if (drained && !settled) {
                        settled = true;
                        stdin.off('drain', onDrain);
                        resolve();
                    }
                });

                drained = drained || ok;
                if (ok) {
                    // No drain will be emitted for this write; remove the listener immediately.
                    stdin.off('drain', onDrain);
                }
            });
        },
        close() {
            return new Promise((resolve) => {
                safeCloseCapture(capture?.stdinStream);
                stdin.end(resolve);
            });
        },
        abort(reason) {
            safeCloseCapture(capture?.stdinStream);
            stdin.destroy(reason instanceof Error ? reason : new Error(String(reason)));
        },
    });

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
