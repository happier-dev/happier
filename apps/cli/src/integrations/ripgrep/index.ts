/**
 * Low-level ripgrep wrapper - just arguments in, string out
 */

import { StringDecoder } from 'node:string_decoder';
import { isSpawnWorkingDirectoryMissing } from '@/processes/spawnFailure/classifySpawnFailure';
import { currentWorkspaceSource, type WorkspaceChildProcess } from '@/workspaces/source/workspaceSource';

export interface RipgrepResult {
    exitCode: number
    /** Raw bounded bytes decoded as UTF-8; consumers discard incomplete trailing records. */
    stdout: string
    stderr: string
    stdoutTruncated?: boolean
    stderrTruncated?: boolean
    stoppedEarly?: boolean
    deadlineExceeded?: boolean
}

export interface RipgrepOptions {
    /** Source-admitted operands, kept separate so the launcher can batch without dropping files. */
    paths?: readonly string[]
    cwd?: string
    signal?: AbortSignal
    maxStdoutBytes?: number
    maxStderrBytes?: number
    terminateOnStdoutLimit?: boolean
    /** Consume newline-delimited records at the process boundary; false stops the process tree. */
    onStdoutLine?: (line: string) => boolean | void
    collectStdout?: boolean
    /** Supplied by the containing operation; returns captured partial output at expiry. */
    deadlineAtMs?: number
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
    // The admitted request's workspace source owns where ripgrep runs and how it is launched.
    const source = currentWorkspaceSource();
    if (options?.signal?.aborted) {
        return Promise.reject(createRipgrepAbortError());
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        let child: WorkspaceChildProcess | null = null;
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let deadlineTimer: ReturnType<typeof setTimeout> | undefined;

        const cleanup = () => {
            options?.signal?.removeEventListener('abort', onAbort);
            if (deadlineTimer) clearTimeout(deadlineTimer);
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
        const rejectSpawnError = (error: unknown) => rejectOnce(source.kind === 'local' && isSpawnWorkingDirectoryMissing(options?.cwd)
            ? Object.assign(new Error('The workspace folder no longer exists on this machine', { cause: error }), { code: 'WORKSPACE_ROOT_NOT_FOUND' })
            : error);
        const onAbort = () => {
            if (settled) return;
            if (child) {
                // The launcher can own a native ripgrep child on some platform
                // paths. Delegate teardown to the canonical cross-platform tree
                // owner instead of killing only its immediate runtime process.
                void child.terminateTree().catch(() => {});
            }
            rejectOnce(createRipgrepAbortError());
        };

        options?.signal?.addEventListener('abort', onAbort, { once: true });
        const armDeadline = () => {
            if (options?.deadlineAtMs === undefined || settled) return;
            const remainingMs = options.deadlineAtMs - Date.now();
            if (remainingMs > 0) {
                deadlineTimer = setTimeout(armDeadline, Math.min(2_147_483_647, remainingMs));
                return;
            }
            if (child) void child.terminateTree().catch(() => {});
            // Completion is owned here, not by waiting for process-tree teardown.
            // Only complete records in this bounded snapshot become domain hits.
            resolveOnce({ exitCode: 1,
                stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
                stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8'),
                stdoutTruncated: true, stoppedEarly: true, deadlineExceeded: true });
        };
        armDeadline();
        void (async () => {
            if (settled) return;
            const launch = await source.toolLaunch({ tool: 'ripgrep', args, ...(options?.paths ? { paths: options.paths } : {}) });
            if (settled || options?.signal?.aborted) {
                return;
            }
            let spawned: WorkspaceChildProcess;
            try {
                spawned = source.spawn({ command: launch.command, args: launch.args, ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}) });
            } catch (error) {
                rejectSpawnError(error);
                return;
            }
            child = spawned;

            let stdoutTruncated = false;
            let stderrTruncated = false;
            let outputLimitTerminationStarted = false;
            let stoppedEarly = false;
            const stdoutDecoder = new StringDecoder('utf8');
            let pendingLine = '';
            const stopProcess = () => {
                if (outputLimitTerminationStarted) return;
                outputLimitTerminationStarted = true;
                void spawned.terminateTree().catch(() => {});
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
                if (settled) return;
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
                if (settled) return;
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
                rejectSpawnError(err);
            });
            spawned.stdin.on('error', rejectOnce);
            spawned.stdin.end(launch.stdin ?? '');
            if (options?.signal?.aborted) {
                onAbort();
            }
        })().catch(rejectOnce);
    });
}
