/**
 * Low-level ripgrep wrapper - just arguments in, string out
 */

import { spawn } from 'child_process';
import { StringDecoder } from 'node:string_decoder';
import { requireJavaScriptRuntimeExecutable } from '@/packagedRuntime/js/requireJavaScriptRuntimeExecutable';
import { isBun } from '@/utils/runtime';
import { resolveCliRuntimeAssetPath } from '@/packagedRuntime/assets/resolveCliRuntimeAssetPath';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';

export interface RipgrepResult {
    exitCode: number
    stdout: string
    stderr: string
    stdoutTruncated?: boolean
    stderrTruncated?: boolean
    stoppedEarly?: boolean
}

export interface RipgrepOptions {
    cwd?: string
    signal?: AbortSignal
    maxStdoutBytes?: number
    maxStderrBytes?: number
    terminateOnStdoutLimit?: boolean
    /** Consume newline-delimited records at the process boundary; false stops the process tree. */
    onStdoutLine?: (line: string) => boolean | void
    collectStdout?: boolean
}

function createRipgrepAbortError(): Error {
    const error = new Error('Ripgrep operation was aborted');
    error.name = 'AbortError';
    Object.assign(error, { code: 'RIPGREP_ABORTED' });
    return error;
}

/**
 * Run ripgrep with the given arguments
 * @param args - Array of command line arguments to pass to ripgrep
 * @param options - Options for ripgrep execution
 * @returns Promise with exit code, stdout and stderr
 */
export function run(args: string[], options?: RipgrepOptions): Promise<RipgrepResult> {
    const RUNNER_PATH = resolveCliRuntimeAssetPath('scripts', 'ripgrep_launcher.cjs');
    if (options?.signal?.aborted) {
        return Promise.reject(createRipgrepAbortError());
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        let child: ReturnType<typeof spawn> | null = null;

        const cleanup = () => {
            options?.signal?.removeEventListener('abort', onAbort);
        };
        const resolveOnce = (value: RipgrepResult) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(value);
        };
        const rejectOnce = (error: unknown) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };
        const onAbort = () => {
            if (settled) return;
            if (child) {
                // The launcher can own a native ripgrep child on some platform
                // paths. Delegate teardown to the canonical cross-platform tree
                // owner instead of killing only its immediate runtime process.
                void killProcessTree(child).catch(() => {});
            }
            rejectOnce(createRipgrepAbortError());
        };

        options?.signal?.addEventListener('abort', onAbort, { once: true });
        void (async () => {
            const runtimeExecutable = await requireJavaScriptRuntimeExecutable({
                isBunRuntime: isBun(),
                targetLabel: 'ripgrep launcher',
            });
            if (settled || options?.signal?.aborted) {
                return;
            }
            const spawned = spawn(runtimeExecutable, [RUNNER_PATH, JSON.stringify(args)], {
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: options?.cwd,
                windowsHide: true,
            });
            child = spawned;

            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];
            let stdoutBytes = 0;
            let stderrBytes = 0;
            let stdoutTruncated = false;
            let stderrTruncated = false;
            let outputLimitTerminationStarted = false;
            let stoppedEarly = false;
            const stdoutDecoder = new StringDecoder('utf8');
            let pendingLine = '';
            const stopProcess = () => {
                if (outputLimitTerminationStarted) return;
                outputLimitTerminationStarted = true;
                void killProcessTree(spawned).catch(() => {});
            };
            const deliverLine = (line: string) => {
                if (stoppedEarly || settled) return;
                try {
                    if (options?.onStdoutLine?.(line) === false) {
                        stoppedEarly = true;
                        stopProcess();
                    }
                } catch (error) {
                    stopProcess();
                    rejectOnce(error);
                }
            };

            const appendBounded = (
                chunks: Buffer[],
                chunk: Buffer,
                currentBytes: number,
                maxBytes: number | undefined,
            ): Readonly<{ bytes: number; truncated: boolean }> => {
                if (maxBytes === undefined) {
                    chunks.push(chunk);
                    return { bytes: currentBytes + chunk.byteLength, truncated: false };
                }
                const remaining = Math.max(0, maxBytes - currentBytes);
                if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
                return {
                    bytes: currentBytes + Math.min(remaining, chunk.byteLength),
                    truncated: chunk.byteLength > remaining,
                };
            };

            spawned.stdout.on('data', (data) => {
                const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
                if (options?.collectStdout !== false) {
                    const appended = appendBounded(stdoutChunks, chunk, stdoutBytes, options?.maxStdoutBytes);
                    stdoutBytes = appended.bytes;
                    stdoutTruncated ||= appended.truncated;
                    if (stdoutTruncated && options?.terminateOnStdoutLimit) stopProcess();
                }
                if (options?.onStdoutLine && !stoppedEarly && !settled) {
                    pendingLine += stdoutDecoder.write(chunk);
                    let newline: number;
                    while (!stoppedEarly && !settled && (newline = pendingLine.indexOf('\n')) !== -1) {
                        const line = pendingLine.slice(0, newline);
                        pendingLine = pendingLine.slice(newline + 1);
                        deliverLine(line);
                    }
                    if (stoppedEarly || settled) pendingLine = '';
                }
            });

            spawned.stderr.on('data', (data) => {
                const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
                const appended = appendBounded(stderrChunks, chunk, stderrBytes, options?.maxStderrBytes);
                stderrBytes = appended.bytes;
                stderrTruncated ||= appended.truncated;
            });

            spawned.on('close', (code) => {
                if (options?.onStdoutLine && !stoppedEarly && !settled) {
                    pendingLine += stdoutDecoder.end();
                    if (pendingLine) deliverLine(pendingLine);
                }
                resolveOnce({
                    exitCode: typeof code === 'number' ? code : 1,
                    stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
                    stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8'),
                    ...(stdoutTruncated ? { stdoutTruncated: true } : {}),
                    ...(stderrTruncated ? { stderrTruncated: true } : {}),
                    ...(stoppedEarly ? { stoppedEarly: true } : {}),
                });
            });

            spawned.on('error', (err) => {
                rejectOnce(err);
            });
            if (options?.signal?.aborted) {
                onAbort();
            }
        })().catch(rejectOnce);
    });
}
