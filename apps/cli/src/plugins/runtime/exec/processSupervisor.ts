import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';

import type {
    PluginProcessHandle,
    PluginProcessObservedTermination,
    PluginProcessOutput,
    PluginProcessResult,
    PluginProcessTerminationRequest,
} from '@happier-dev/plugin-sdk/exec';
import { PluginError } from '@happier-dev/plugin-sdk';

import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import {
    removeProcessCustodyHandshakeFile,
    terminateProcessCustodyByJob,
    waitForProcessCustodyHandshake,
    type ProcessCustodySpawnSpec,
} from '@/subprocess/supervision/processCustody';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';

type DisposeReason = Extract<PluginProcessTerminationRequest, { kind: 'dispose' }>['reason'];

// Host-internal workload guard pending RA21 traffic/platform measurement. Authors may
// select a smaller result buffer, but cannot turn process supervision into an
// unbounded in-memory output collector.
const INTERNAL_MAX_BUFFERED_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;

const HOST_PROCESS_CHILDREN = new WeakMap<
    PluginProcessHandle,
    Pick<ChildProcessWithoutNullStreams, 'pid'>
>();

// Host-only custody lookup. The public handle deliberately carries no OS process identity.
export function associateSupervisedPluginProcessHandleForHost(
    handle: PluginProcessHandle,
    child: Pick<ChildProcessWithoutNullStreams, 'pid'>,
): void {
    HOST_PROCESS_CHILDREN.set(handle, child);
}

export function readSupervisedPluginProcessIdForHost(
    handle: PluginProcessHandle,
): number | null {
    return HOST_PROCESS_CHILDREN.get(handle)?.pid ?? null;
}

export type SupervisedPluginProcess = Readonly<{
    child: ChildProcessWithoutNullStreams;
    handle: PluginProcessHandle;
    readBufferedStderr(): Uint8Array;
    requestTermination(request: Exclude<PluginProcessTerminationRequest, { kind: 'none' }>): Promise<void>;
    dispose(reason?: DisposeReason): Promise<void>;
}>;

/**
 * Native process-tree custody for one supervised spawn. The command is the
 * custody helper itself; the facts here name the generation-unique containment
 * it must establish and the post-assignment handshake it must publish.
 */
type SpawnProcessCustodySpec = ProcessCustodySpawnSpec;

/** Host-private custody facts proven by one handshake. */
export type SupervisedPluginProcessCustody = Readonly<{
    jobName: string;
    targetPid: number;
}>;

/**
 * Bounded wait for the helper's post-assignment handshake. A `null` answer
 * means custody was never proven — the caller must not publish, project, or
 * use the process, and must fail its establishment instead.
 */
export function waitForSupervisedPluginProcessCustody(
    input: Readonly<{
        custody: SpawnProcessCustodySpec;
        signal?: AbortSignal;
        timeoutMs?: number;
    }>,
): Promise<SupervisedPluginProcessCustody | null> {
    return (async () => {
        const facts = await waitForProcessCustodyHandshake({
            handshakePath: input.custody.handshakePath,
            jobName: input.custody.jobName,
            ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
            ...(input.signal ? { isAborted: (): boolean => input.signal!.aborted } : {}),
        });
        if (!facts) {
            // An unread marker must never linger where a later spawn could
            // mistake it for testimony.
            await removeProcessCustodyHandshakeFile(input.custody.handshakePath);
            return null;
        }
        const custody: SupervisedPluginProcessCustody = Object.freeze({
            jobName: input.custody.jobName,
            targetPid: facts.pid,
        });
        return custody;
    })();
}

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
    /** Native containment facts; present only when the command is the custody helper. */
    processCustody?: SpawnProcessCustodySpec;
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

function terminationIncompleteError(cause?: unknown): PluginError {
    return new PluginError({
        code: 'plugin_exec_termination_incomplete',
        message: 'Plugin process termination could not be verified',
        retryable: true,
    }, cause === undefined ? undefined : { cause });
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
    let resolveObserved!: () => void;
    const waitPromise = new Promise<PluginProcessResult>((resolve) => {
        resolveWait = resolve;
    });
    const observedPromise = new Promise<void>((resolve) => {
        resolveObserved = resolve;
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
        resolveObserved();
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
        if (terminationPromise) return terminationPromise;
        const attempt = (async () => {
            const terminate = input.terminateProcessTree
                ?? (async (target: ChildProcessWithoutNullStreams) => {
                    if (input.processCustody) {
                        // The containment is the named job, not this process:
                        // terminate by job and prove the FULL member list gone,
                        // including every descendant, including after the
                        // root already exited. An unproven outcome keeps the
                        // job and reports termination as incomplete.
                        const outcome = await terminateProcessCustodyByJob({
                            executablePath: input.processCustody.executablePath,
                            jobName: input.processCustody.jobName,
                        });
                        if (outcome !== 'absent') {
                            throw terminationIncompleteError(
                                new Error(`Job custody termination was not proven (${outcome})`),
                            );
                        }
                        return;
                    }
                    await killProcessTree(target, { graceMs: 100 });
                });
            const joined = (async () => {
                // Root exit settles process output, not the owned containment.
                // Always ask the canonical tree terminator to prove the POSIX
                // process group / Windows tree absent, including when the
                // launcher root exited before disposal began.
                await terminate(child);
                await observedPromise;
                seal();
            })();
            // A bounded caller wait may finish first. Keep a rejection from a
            // later tree-kill attempt observed without relabeling the process.
            void joined.catch(() => undefined);
            const joinTimeoutMs = Math.max(1, input.terminationJoinTimeoutMs ?? 5_000);
            let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
            let joinedBeforeDeadline: boolean;
            try {
                joinedBeforeDeadline = await Promise.race([
                    joined.then(() => true),
                    new Promise<false>((resolve) => {
                        timeoutHandle = setTimeout(() => resolve(false), joinTimeoutMs);
                        timeoutHandle.unref?.();
                    }),
                ]);
            } catch (error) {
                if (!observed && (child.exitCode !== null || child.signalCode !== null)) {
                    freezeObserved(observedTermination(child.exitCode, child.signalCode));
                }
                if (observed) seal();
                throw terminationIncompleteError(error);
            } finally {
                if (timeoutHandle) clearTimeout(timeoutHandle);
            }
            if (!joinedBeforeDeadline) {
                // A join deadline is a bounded caller wait, not evidence that
                // the OS-owned containment is absent. Keep host-private custody
                // even when the root process itself already exited.
                if (observed) seal();
                throw terminationIncompleteError();
            }
        })();
        terminationPromise = attempt;
        void attempt.catch(() => {
            if (terminationPromise === attempt) {
                terminationPromise = null;
            }
        });
        return attempt;
    };

    const abort = () => {
        void requestTermination({ kind: 'abort' }).catch(() => undefined);
    };
    for (const signal of input.signals ?? []) {
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    }
    if (input.timeoutMs !== undefined) {
        timeout = setTimeout(() => {
            void requestTermination({ kind: 'timeout' }).catch(() => undefined);
        }, Math.max(0, input.timeoutMs));
        timeout.unref?.();
    }
    if (input.stdin !== undefined) {
        child.stdin.end(input.stdin);
    }

    const dispose = (reason: DisposeReason = 'caller'): Promise<void> => {
        if (disposePromise) return disposePromise;
        const attempt = (async () => {
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
        disposePromise = attempt;
        void attempt.catch(() => {
            if (disposePromise === attempt) {
                disposePromise = null;
            }
        });
        return attempt;
    };
    const handle: PluginProcessHandle = Object.freeze({
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
    associateSupervisedPluginProcessHandleForHost(handle, child);
    return Object.freeze({
        child,
        handle,
        readBufferedStderr: () => new Uint8Array(Buffer.concat(stderrChunks, stderrBytes)),
        requestTermination,
        dispose,
    });
}
