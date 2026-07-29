import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';

import type {
    PluginProcessHandle,
    PluginProcessObservedTermination,
    PluginProcessOutput,
    PluginProcessResult,
    PluginProcessTerminationRequest,
} from '@happier-dev/plugin-sdk/runtime';

import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';

type DisposeReason = Extract<PluginProcessTerminationRequest, { kind: 'dispose' }>['reason'];

// Host-internal workload guard pending RA21 traffic/platform measurement. Authors may
// select a smaller result buffer, but cannot turn process supervision into an
// unbounded in-memory output collector.
const INTERNAL_MAX_BUFFERED_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;

export type SupervisedPluginProcess = Readonly<{
    child: ChildProcessWithoutNullStreams;
    handle: PluginProcessHandle;
    readBufferedStderr(): Uint8Array;
    requestTermination(request: Exclude<PluginProcessTerminationRequest, { kind: 'none' }>): Promise<void>;
    dispose(reason?: DisposeReason): Promise<void>;
}>;

type SpawnSupervisedPluginProcessInput = Readonly<{
    command: string;
    args: readonly string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdin?: Uint8Array;
    timeoutMs?: number;
    signals?: readonly AbortSignal[];
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    terminationJoinTimeoutMs?: number;
    terminateProcessTree?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
    spawnOptions?: Omit<SpawnOptionsWithoutStdio, 'cwd' | 'env'>;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
}>;

function appendBounded(
    chunks: readonly Buffer[],
    currentBytes: number,
    chunk: Buffer,
    maximum: number,
): Readonly<{ chunks: readonly Buffer[]; bytes: number; truncated: boolean }> {
    const remaining = Math.max(0, maximum - currentBytes);
    const retained = remaining === 0 ? Buffer.alloc(0) : chunk.subarray(0, remaining);
    return {
        chunks: retained.byteLength === 0 ? chunks : [...chunks, retained],
        bytes: currentBytes + retained.byteLength,
        truncated: chunk.byteLength > remaining,
    };
}

function failedTermination(error: unknown): PluginProcessObservedTermination {
    const errorCode = typeof error === 'object'
        && error !== null
        && 'code' in error
        && typeof error.code === 'string'
        ? error.code
        : undefined;
    return Object.freeze({
        kind: 'failed' as const,
        diagnostic: Object.freeze({
            code: 'PLUGIN_EXEC_PROCESS_FAILED',
            severity: 'error' as const,
            message: 'Process failed after its handle was created',
            ...(errorCode ? { details: { errorCode } } : {}),
        }),
    });
}

function observedTermination(exitCode: number | null, signal: NodeJS.Signals | null): PluginProcessObservedTermination {
    if (typeof exitCode === 'number') {
        return Object.freeze({ kind: 'exit' as const, exitCode });
    }
    if (signal) {
        return Object.freeze({ kind: 'signal' as const, signal });
    }
    return failedTermination(new Error('Process closed without an exit code or signal'));
}

export function spawnSupervisedPluginProcess(input: SpawnSupervisedPluginProcessInput): SupervisedPluginProcess {
    const stdoutMaximum = Math.max(
        0,
        Math.min(
            input.maxStdoutBytes ?? INTERNAL_MAX_BUFFERED_PROCESS_OUTPUT_BYTES,
            INTERNAL_MAX_BUFFERED_PROCESS_OUTPUT_BYTES,
        ),
    );
    const stderrMaximum = Math.max(
        0,
        Math.min(
            input.maxStderrBytes ?? INTERNAL_MAX_BUFFERED_PROCESS_OUTPUT_BYTES,
            INTERNAL_MAX_BUFFERED_PROCESS_OUTPUT_BYTES,
        ),
    );
    const recordRuntimeLimitMeasurement = input.recordRuntimeLimitMeasurement;
    const child = spawn(input.command, [...input.args], {
        cwd: input.cwd,
        env: input.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        ...input.spawnOptions,
    });
    const outputListeners = new Set<(chunk: PluginProcessOutput) => void>();
    let stdoutChunks: readonly Buffer[] = [];
    let stderrChunks: readonly Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const outputMeasurement = recordRuntimeLimitMeasurement
        ? {
            stdoutChunks: 0,
            stderrChunks: 0,
            stdoutBytes: 0,
            stderrBytes: 0,
        }
        : undefined;
    let sequence = 0;
    let requestedBy: PluginProcessTerminationRequest | null = null;
    let observed: PluginProcessObservedTermination | null = null;
    let terminalResult: PluginProcessResult | null = null;
    let resolveWait!: (result: PluginProcessResult) => void;
    const waitPromise = new Promise<PluginProcessResult>((resolve) => {
        resolveWait = resolve;
    });
    let terminationPromise: Promise<void> | null = null;
    let disposePromise: Promise<void> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const publishOutput = (stream: 'stdout' | 'stderr', value: Buffer): void => {
        const event = Object.freeze({
            sequence: ++sequence,
            stream,
            data: new Uint8Array(value),
        });
        for (const listener of [...outputListeners]) {
            try {
                listener(event);
            } catch {
                // One plugin listener cannot interrupt process supervision or later listeners.
            }
        }
    };

    child.stdout.on('data', (value: Buffer | Uint8Array | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        publishOutput('stdout', chunk);
        const next = appendBounded(stdoutChunks, stdoutBytes, chunk, stdoutMaximum);
        stdoutChunks = next.chunks;
        stdoutBytes = next.bytes;
        stdoutTruncated ||= next.truncated;
        if (recordRuntimeLimitMeasurement && outputMeasurement) {
            outputMeasurement.stdoutChunks += 1;
            outputMeasurement.stdoutBytes += chunk.byteLength;
            recordRuntimeLimitMeasurement(Object.freeze({
                family: 'plugin-process-stdout',
                queuedItems: outputMeasurement.stdoutChunks,
                queuedBytes: outputMeasurement.stdoutBytes,
                backpressured: stdoutTruncated,
                sequence,
            }));
        }
    });
    child.stderr.on('data', (value: Buffer | Uint8Array | string) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        publishOutput('stderr', chunk);
        const next = appendBounded(stderrChunks, stderrBytes, chunk, stderrMaximum);
        stderrChunks = next.chunks;
        stderrBytes = next.bytes;
        stderrTruncated ||= next.truncated;
        if (recordRuntimeLimitMeasurement && outputMeasurement) {
            outputMeasurement.stderrChunks += 1;
            outputMeasurement.stderrBytes += chunk.byteLength;
            recordRuntimeLimitMeasurement(Object.freeze({
                family: 'plugin-process-stderr',
                queuedItems: outputMeasurement.stderrChunks,
                queuedBytes: outputMeasurement.stderrBytes,
                backpressured: stderrTruncated,
                sequence,
            }));
        }
    });
    child.stdin.on('error', () => {
        // Individual writes receive their callback error; prevent an unhandled EPIPE.
    });

    const freezeObserved = (next: PluginProcessObservedTermination): void => {
        if (observed) return;
        observed = next;
        requestedBy ??= Object.freeze({ kind: 'none' as const });
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
    };
    const seal = (): void => {
        if (terminalResult || !observed || !requestedBy) return;
        terminalResult = Object.freeze({
            termination: Object.freeze({ observed, requestedBy }),
            stdout: new Uint8Array(Buffer.concat(stdoutChunks, stdoutBytes)),
            stderr: new Uint8Array(Buffer.concat(stderrChunks, stderrBytes)),
            stdoutTruncated,
            stderrTruncated,
        });
        resolveWait(terminalResult);
    };

    child.once('error', (error) => {
        freezeObserved(failedTermination(error));
        seal();
    });
    child.once('exit', (exitCode, signal) => {
        freezeObserved(observedTermination(exitCode, signal));
    });
    child.once('close', (exitCode, signal) => {
        freezeObserved(observedTermination(exitCode, signal));
        seal();
    });

    const requestTermination = (request: Exclude<PluginProcessTerminationRequest, { kind: 'none' }>): Promise<void> => {
        if (!observed && (child.exitCode !== null || child.signalCode !== null)) {
            freezeObserved(observedTermination(child.exitCode, child.signalCode));
        }
        if (!observed && !requestedBy) {
            requestedBy = Object.freeze({ ...request });
        }
        terminationPromise ??= (async () => {
            const terminate = input.terminateProcessTree ?? (async (target: ChildProcessWithoutNullStreams) => {
                try {
                    await killProcessTree(target, { graceMs: 100 });
                } catch {
                    try {
                        target.kill();
                    } catch {
                        // The process may have won the terminal race.
                    }
                }
            });
            const joined = (async () => {
                if (!observed) {
                    await terminate(child);
                }
                await waitPromise;
            })();
            const joinTimeoutMs = Math.max(1, input.terminationJoinTimeoutMs ?? 5_000);
            let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
            const joinedBeforeDeadline = await Promise.race([
                joined.then(() => true),
                new Promise<false>((resolve) => {
                    timeoutHandle = setTimeout(() => resolve(false), joinTimeoutMs);
                    timeoutHandle.unref?.();
                }),
            ]);
            if (timeoutHandle) clearTimeout(timeoutHandle);
            if (!joinedBeforeDeadline) {
                if (!observed) {
                    freezeObserved(Object.freeze({
                        kind: 'failed' as const,
                        diagnostic: Object.freeze({
                            code: 'PLUGIN_EXEC_TERMINATION_TIMEOUT',
                            severity: 'error' as const,
                            message: 'Process tree did not terminate before the bounded join deadline',
                        }),
                    }));
                }
                seal();
            }
        })();
        return terminationPromise;
    };

    const abort = () => {
        void requestTermination({ kind: 'abort' });
    };
    for (const signal of input.signals ?? []) {
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    }
    if (input.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
            void requestTermination({ kind: 'timeout' });
        }, Math.max(0, input.timeoutMs));
        timeout.unref?.();
    }
    if (input.stdin !== undefined) {
        child.stdin.end(input.stdin);
    }

    const dispose = (reason: DisposeReason = 'caller'): Promise<void> => {
        disposePromise ??= (async () => {
            for (const signal of input.signals ?? []) {
                signal.removeEventListener('abort', abort);
            }
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            await requestTermination({ kind: 'dispose', reason });
            outputListeners.clear();
        })();
        return disposePromise;
    };
    const handle: PluginProcessHandle = Object.freeze({
        pid: child.pid ?? null,
        async write(data: Uint8Array) {
            await new Promise<void>((resolve, reject) => {
                child.stdin.write(data, (error) => error ? reject(error) : resolve());
            });
        },
        async closeStdin() {
            await new Promise<void>((resolve, reject) => {
                child.stdin.end((error?: Error | null) => error ? reject(error) : resolve());
            });
        },
        wait: () => waitPromise,
        onOutput(listener: (chunk: PluginProcessOutput) => void) {
            outputListeners.add(listener);
            return Object.freeze({
                dispose: () => {
                    outputListeners.delete(listener);
                },
            });
        },
        dispose: () => dispose('caller'),
    });
    return Object.freeze({
        child,
        handle,
        readBufferedStderr: () => new Uint8Array(Buffer.concat(stderrChunks, stderrBytes)),
        requestTermination,
        dispose,
    });
}
