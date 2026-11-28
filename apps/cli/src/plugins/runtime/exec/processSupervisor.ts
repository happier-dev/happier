import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import type { Writable } from 'node:stream';
import { sessionProcessEnvironment } from '@/agent/runtime/lifecycle/hostedSessionScope';

import type {
    ExecService,
    PluginProcessHandle,
    PluginProcessObservedTermination,
    PluginProcessOutput,
    PluginProcessResult,
    PluginProcessTerminationRequest,
} from '@happier-dev/plugin-sdk/exec';
import { PluginError } from '@happier-dev/plugin-sdk/errors';

import { readProcessCensus } from '@/processes/census/processCensus';
import { captureProcessTree, createProcessTreeTerminator, terminateProcessTree, type ProcessTreeCapture } from '@/processes/terminate/terminateProcessTree';
import {
    removeProcessCustodyHandshakeFile,
    waitForProcessCustodyHandshake,
    type ProcessCustodySpawnSpec,
} from '@/subprocess/supervision/processCustody';
import type { HostRuntimeLimitMeasurementRecorder } from '@/agent/runtime/state/runtimeLimitMeasurement';
import type { SpawnFailureLimitsReader } from '@/processes/spawnFailure/classifySpawnFailure';
import type { OwnerRemainderPort } from '@/daemon/processes/endOwnerRemainder';
import { parseProcessOwnerTag, PROCESS_OWNER_ENV_KEY, type ProcessOwnerRef } from '@/processes/ownerTag';
import { observeProcessLaunch } from '@/processes/launchNotification';
import { adoptSessionHolderChild, resolveSessionProcessHolderLaunch, SessionHolderChild, spawnSessionHolderChild, type AgentSessionHolderLaunch } from '@/subprocess/supervision/sessionHolder';
import { logger } from '@/ui/logger';
import { PROCESS_TERMINATION_GRACE_MS } from '@/subprocess/supervision/terminationPolicy';
import type { ProviderRedactionLease } from '@/providers/spawn/redaction';
import { createProcessOutputRedaction } from './processOutputRedaction';
import { projectPluginExecSpawnFailure } from './errors';

/** Keep the pipe's error event handled while each write returns its own failure. */
export function createProcessStdinWriter(stdin: Writable): (data: Uint8Array) => Promise<void> {
    stdin.on('error', () => {
        // Individual writes receive their callback error; prevent an unhandled EPIPE.
    });
    return data => new Promise<void>((resolve, reject) => {
        stdin.write(data, error => error ? reject(error) : resolve());
    });
}

type DisposeReason = Extract<PluginProcessTerminationRequest, { kind: 'dispose' }>['reason'];
export type SupervisedPluginGracefulStop = (signal: AbortSignal) => Promise<void>;
export { PROCESS_TERMINATION_GRACE_MS } from '@/subprocess/supervision/terminationPolicy';

// Host-internal workload guard pending RA21 traffic/platform measurement. Authors may
// select a smaller result buffer, but cannot turn process supervision into an
// unbounded in-memory output collector.
export const MAX_BUFFERED_PLUGIN_PROCESS_OUTPUT_BYTES = 8 * 1024 * 1024;

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

/** Lease settlement is distinct from proof that every descendant was cleaned. */
export type SupervisedProcessSettlement = Readonly<{ status: 'ended'; remainder?: 'unobserved' }>;

type SupervisedPluginChild = ChildProcessWithoutNullStreams | SessionHolderChild;

export type SupervisedPluginProcess = Readonly<{
    child: SupervisedPluginChild;
    handle: PluginProcessHandle;
    readBufferedStderr(): Uint8Array;
    requestTermination(request: Exclude<PluginProcessTerminationRequest, { kind: 'none' }>): Promise<void>;
    dispose(reason?: DisposeReason, options?: Readonly<{ beforeTerminate?: SupervisedPluginGracefulStop }>): Promise<void>;
    /** An unobserved shared-owner remainder is not a cleanup guarantee. */
    waitForSettlement(): Promise<SupervisedProcessSettlement>;
    onOutcomeUncertain(listener: (error: unknown) => void): () => void;
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
    requiredFiles?: readonly string[];
    /** Host-admitted late Provider environment for the placed native Agent. */
    providerEnvironmentKeys?: readonly string[];
    /** Host-owned binary stdout is consumed directly, never decoded or retained. */
    pipeStdout?: true;
    /** Host-private launch frame, ordered before all provider input. */
    stdinPreamble?: Uint8Array;
    timeoutMs?: number;
    descendantDisposition?: NonNullable<Parameters<ExecService['spawn']>[1]>['descendantDisposition'];
    signals?: readonly AbortSignal[];
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    terminationJoinTimeoutMs?: number;
    terminateProcessTree?: (child: SupervisedPluginChild) => Promise<void>;
    /** Let an admitted native activation run its own cleanup before tree settlement. */
    waitForGracefulRootExitBeforeTreeStop?: true;
    /** Native containment facts; present only when the command is the custody helper. */
    processCustody?: SpawnProcessCustodySpec;
    /** Hosted Exec can be stopped before its launcher has established the Job. */
    verifyProcessCustodyOnStop?: true;
    /** Host-only native observation/termination boundaries, never plugin options. */
    processTreeSystemBoundary?: Parameters<typeof createProcessTreeTerminator>[0];
    spawnOptions?: Omit<SpawnOptionsWithoutStdio, 'cwd' | 'env'>;
    recordRuntimeLimitMeasurement?: HostRuntimeLimitMeasurementRecorder;
    readSpawnFailureLimits?: SpawnFailureLimitsReader;
    /** Sanitize before either plugin output delivery or host result buffering. */
    secretRedactionLease?: ProviderRedactionLease;
    /** Generic daemon-scoped IO observes leftovers; it has no exclusive Run/Service identity. */
    rootExitObservation?: Readonly<{ owner: Extract<ProcessOwnerRef, { kind: 'happier' }>; ownerRemainder: OwnerRemainderPort }>;
    /**
     * Agent custody: the per-Session holder starts the command and owns its pipes
     * and process group, so this process can end without ending the Agent.
     * `adopt` attaches to an Agent a previous runner started (by holder address
     * from the launch decision, or an already attached child).
     */
    sessionHolder?: AgentSessionHolderLaunch | null
        | Readonly<{ kind: 'adopt'; child: SessionHolderChild }>;
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

function failedTermination(error: unknown, failure?: ReturnType<typeof projectPluginExecSpawnFailure>): PluginProcessObservedTermination {
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
            message: failure?.message ?? 'Process failed after its handle was created',
            ...(errorCode || failure ? { details: {
                ...(errorCode ? { errorCode } : {}),
                ...(failure ? { ...failure.details, failureCause: failure.failureCause } : {}),
            } } : {}),
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
    const terminateCustody = input.processTreeSystemBoundary
        ? createProcessTreeTerminator(input.processTreeSystemBoundary) : terminateProcessTree;
    const ownerTag = (input.env ?? sessionProcessEnvironment())[PROCESS_OWNER_ENV_KEY];
    const processOwner = parseProcessOwnerTag(ownerTag)?.owner;
    const sharedOwner = ownerTag === undefined || processOwner?.kind === 'session'
        || (processOwner?.kind === 'happier' && processOwner.component === undefined);
    const stdoutMaximum = Math.max(
        0,
        Math.min(
            input.maxStdoutBytes ?? MAX_BUFFERED_PLUGIN_PROCESS_OUTPUT_BYTES,
            MAX_BUFFERED_PLUGIN_PROCESS_OUTPUT_BYTES,
        ),
    );
    const stderrMaximum = Math.max(
        0,
        Math.min(
            input.maxStderrBytes ?? MAX_BUFFERED_PLUGIN_PROCESS_OUTPUT_BYTES,
            MAX_BUFFERED_PLUGIN_PROCESS_OUTPUT_BYTES,
        ),
    );
    const recordRuntimeLimitMeasurement = input.recordRuntimeLimitMeasurement;
    const spawnStartedAt = performance.now();
    const holder = input.sessionHolder === undefined ? resolveSessionProcessHolderLaunch() : input.sessionHolder;
    const child: SupervisedPluginChild = holder?.kind === 'adopt'
        ? 'child' in holder ? holder.child : adoptSessionHolderChild({ socketPath: holder.socketPath, role: holder.role,
            ...('turnId' in holder && holder.turnId ? { turnId: holder.turnId } : {}),
            ...('target' in holder && holder.target ? { target: holder.target } : {}) })
        : holder?.kind === 'spawn' ? spawnSessionHolderChild({ executablePath: holder.executablePath, socketPath: holder.socketPath,
            ...('role' in holder ? { role: holder.role } : {}),
            command: input.command, args: input.args, ...(input.cwd ? { cwd: input.cwd } : {}), ...(input.env ? { env: input.env } : {}),
            ...(input.requiredFiles ? { requiredFiles: input.requiredFiles } : {}),
            ...(input.providerEnvironmentKeys ? { providerEnvironmentKeys: input.providerEnvironmentKeys } : {}),
            ...(input.signals?.length ? { signal: AbortSignal.any([...input.signals]) } : {}),
            ...(input.spawnOptions?.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
            ...('target' in holder && holder.target ? { target: holder.target } : {}) })
        : spawn(input.command, [...input.args], {
            cwd: input.cwd,
            env: input.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            ...input.spawnOptions,
            windowsHide: true,
        });
    observeProcessLaunch(child);
    child.once('spawn', () => logger.infoFile('[PluginExec] Process launched', {
        phase: 'launcher_spawn',
        pid: child.pid,
        // `spawn`/`adopt`: held by the Session holder; `direct`: this process's own child.
        holder: holder?.kind ?? 'direct',
        ...(processOwner ? { owner: processOwner } : {}),
        durationMs: Math.round(performance.now() - spawnStartedAt),
    }));
    let rootExitCapture = input.rootExitObservation && child.pid
        ? input.rootExitObservation.ownerRemainder.captureTree(input.rootExitObservation.owner, { pid: child.pid })
        : undefined;
    let refreshedRootExitCapture = false;
    let capturedTreeOnOutput: Promise<ProcessTreeCapture> | undefined;
    const refreshRootExitCapture = () => {
        if (refreshedRootExitCapture || !child.pid
            || child.exitCode !== null || child.signalCode !== null) return;
        const needsNativeCapture = !input.rootExitObservation && !input.processCustody
            && !input.terminateProcessTree && (input.spawnOptions?.detached === true
                || (process.platform !== 'win32' && input.spawnOptions?.detached === false));
        if (!input.rootExitObservation && !needsNativeCapture) return;
        refreshedRootExitCapture = true;
        // One existing first-output boundary offers a later pre-exit observation;
        // never sample on every chunk or add an observer cadence.
        if (input.rootExitObservation) {
            rootExitCapture = input.rootExitObservation.ownerRemainder.captureTree(input.rootExitObservation.owner, { pid: child.pid });
        } else {
            capturedTreeOnOutput = captureProcessTree({ pid: child.pid });
            void capturedTreeOnOutput.catch(() => undefined);
        }
    };
    let rootExitObservation: Promise<unknown> | undefined;
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
    let resolveObserved!: (termination: PluginProcessResult['termination']) => void;
    const waitPromise = new Promise<PluginProcessResult>((resolve) => {
        resolveWait = resolve;
    });
    const observedPromise = new Promise<PluginProcessResult['termination']>((resolve) => {
        resolveObserved = resolve;
    });
    let resolveSettlement!: (result: SupervisedProcessSettlement) => void;
    let settled = false;
    let uncertain: unknown;
    const settlementPromise = new Promise<SupervisedProcessSettlement>(resolve => { resolveSettlement = resolve; });
    const uncertaintyListeners = new Set<(error: unknown) => void>();
    const confirmSettlement = (remainder?: SupervisedProcessSettlement['remainder']) => {
        if (settled) return;
        settled = true;
        uncertain = undefined;
        uncertaintyListeners.clear();
        resolveSettlement(Object.freeze({ status: 'ended', ...(remainder ? { remainder } : {}) }));
    };
    let terminationPromise: Promise<void> | null = null;
    let disposePromise: Promise<void> | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const hostedJob = input.verifyProcessCustodyOnStop ? input.processCustody : undefined;
    const hostedJobLifetime = hostedJob ? new AbortController() : undefined;
    let hostedJobFacts: SupervisedPluginProcessCustody | null = null;

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

    const captureStdout = (chunk: Buffer) => {
        if (!chunk.length) return;
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
    };
    const captureStderr = (chunk: Buffer) => {
        if (!chunk.length) return;
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
    };
    const outputRedaction = input.secretRedactionLease
        ? createProcessOutputRedaction(input.secretRedactionLease, (stream, bytes) => {
            (stream === 'stdout' ? captureStdout : captureStderr)(Buffer.from(bytes));
        })
        : undefined;
    if (input.pipeStdout) {
        // Piped stdout belongs to its binary consumer and never enters this projection.
        outputRedaction?.flush('stdout');
        // The caller owns piped stdout: observing it here must not start the flow before the
        // caller reads, or output already delivered (an adopted Agent's replay) would reach
        // no consumer, and the holder client would acknowledge it as taken.
        child.stdout.once('resume', () => { child.stdout.on('data', refreshRootExitCapture); });
    } else {
        child.stdout.on('data', (value: Buffer | Uint8Array | string) => {
            refreshRootExitCapture();
            const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
            if (outputRedaction) outputRedaction.push('stdout', chunk);
            else captureStdout(chunk);
        });
    }
    child.stderr.on('data', (value: Buffer | Uint8Array | string) => {
        refreshRootExitCapture();
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (outputRedaction) outputRedaction.push('stderr', chunk);
        else captureStderr(chunk);
    });
    child.stdout.once('end', () => { if (!input.pipeStdout) outputRedaction?.flush('stdout'); });
    child.stderr.once('end', () => { outputRedaction?.flush('stderr'); });
    const writeStdin = createProcessStdinWriter(child.stdin);

    const freezeObserved = (next: PluginProcessObservedTermination): void => {
        if (observed) return;
        observed = next;
        requestedBy ??= Object.freeze({ kind: 'none' as const });
        resolveObserved(Object.freeze({ observed, requestedBy }));
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
        const failure = projectPluginExecSpawnFailure(error, {
            cwd: input.cwd, limits: input.readSpawnFailureLimits?.(),
        }, 'Process failed after its handle was created');
        freezeObserved(failedTermination(error, failure));
        if (!child.pid) confirmSettlement();
    });
    child.once('exit', (exitCode, signal) => {
        freezeObserved(observedTermination(exitCode, signal));
        if (input.rootExitObservation) {
            const lifecycle = input.rootExitObservation;
            rootExitObservation = Promise.resolve(rootExitCapture).then(capture => lifecycle.ownerRemainder.observeEnd(lifecycle.owner, capture));
            // Lifecycle diagnostics belong to the shared port, never the byte path.
            void rootExitObservation.catch(() => undefined);
        }
    });
    child.once('close', (exitCode, signal) => {
        freezeObserved(observedTermination(exitCode, signal));
        if (hostedJob) {
            hostedJobLifetime?.abort();
            void removeProcessCustodyHandshakeFile(hostedJob.handshakePath);
        }
        seal();
    });

    const requestTermination = (request: Exclude<PluginProcessTerminationRequest, { kind: 'none' }>, beforeTerminate?: SupervisedPluginGracefulStop): Promise<void> => {
        if (!observed && (child.exitCode !== null || child.signalCode !== null)) {
            freezeObserved(observedTermination(child.exitCode, child.signalCode));
        }
        if (!observed && !requestedBy) {
            requestedBy = Object.freeze({ ...request });
        }
        if (input.descendantDisposition === 'preserve-on-success'
            && !input.processCustody && observed?.kind === 'exit' && observed.exitCode === 0
            && requestedBy?.kind === 'none') {
            // The native tool owns its daemon after successful startup. This is
            // not a Job release or a running-process detachment: accepted abort,
            // timeout and early disposal requests still use normal tree cleanup.
            confirmSettlement();
            return Promise.resolve();
        }
        if (observed && input.rootExitObservation) {
            return Promise.resolve(rootExitObservation).then(() => { confirmSettlement(); });
        }
        if (terminationPromise) return terminationPromise;
        const attempt = (async () => {
            let gracefulStopDeadline: number | undefined;
            if (beforeTerminate && !observed) {
                gracefulStopDeadline = Date.now() + PROCESS_TERMINATION_GRACE_MS;
                const controller = new AbortController();
                let timer: ReturnType<typeof setTimeout> | undefined;
                const expired = new Promise<void>(resolve => {
                    timer = setTimeout(() => { controller.abort(); resolve(); }, PROCESS_TERMINATION_GRACE_MS);
                });
                try {
                    await Promise.race([
                        Promise.resolve().then(() => beforeTerminate(controller.signal)).catch(error => {
                            logger.infoFile('[PluginExec] Graceful protocol stop did not complete', error);
                        }),
                        expired,
                    ]);
                } finally { if (timer) clearTimeout(timer); }
            }
            const terminationOptions = () => {
                const graceMs = gracefulStopDeadline === undefined ? PROCESS_TERMINATION_GRACE_MS
                    : Math.max(0, gracefulStopDeadline - Date.now());
                return { graceMs, ...(graceMs === 0 ? { firstSignal: 'SIGKILL' as const } : {}) };
            };
            const terminate = input.terminateProcessTree
                ?? (async (target: SupervisedPluginChild) => {
                    // A target-held Agent's pids belong to the target: Stop goes through its holder.
                    if (target instanceof SessionHolderChild && target.target) {
                        await target.terminateGroup(terminationOptions());
                        return;
                    }
                    if (input.processCustody) {
                        // Native custody establishes this generation-unique Job.
                        // One terminator rereads its membership and each native identity.
                        const result = await terminateCustody({ targets: [],
                            containment: { kind: 'windows_job', name: input.processCustody.jobName }, policy: 'kill' });
                        if (result.status !== 'complete') throw terminationIncompleteError();
                        return;
                    }
                    await terminateProcessTree(target, {
                        ...terminationOptions(),
                        ownedProcessGroup: process.platform !== 'win32'
                            && input.spawnOptions?.detached === true,
                    });
                });
            const joined = (async () => {
                if (hostedJob && !observed && !hostedJobFacts) {
                    hostedJobFacts = await waitForSupervisedPluginProcessCustody({ custody: hostedJob, signal: hostedJobLifetime?.signal });
                    if (!hostedJobFacts && !observed) throw terminationIncompleteError();
                }
                if (observed && observed.kind !== 'failed' && sharedOwner
                    && !input.terminateProcessTree && !input.processCustody
                    && !input.waitForGracefulRootExitBeforeTreeStop) {
                    const captured = await capturedTreeOnOutput;
                    if (!captured || captured.status !== 'ok') {
                        // The original root ended, but no subtree is known. A
                        // shared tag or recycled numeric group is not custody.
                        // Settle the lease without signalling or claiming cleanup.
                        confirmSettlement('unobserved');
                        return;
                    }
                }
                let capturedTargets: import('@/processes/terminate/terminateProcessTree').ProcessTreeTerminationResult['capturedTargets'];
                if (input.waitForGracefulRootExitBeforeTreeStop && !observed) {
                    // Signalling every descendant first can kill the native
                    // activation watchdog before it releases its service manager.
                    // The existing join budget bounds the caller's wait, not custody.
                    let target: Parameters<typeof captureProcessTree>[0] | undefined = child.pid ? { pid: child.pid } : undefined;
                    if (hostedJobFacts) {
                        const { jobName, targetPid } = hostedJobFacts;
                        const snapshot = await readProcessCensus({
                            freshness: 'fresh', pids: [targetPid], fields: [], verifiedJobNames: [jobName],
                        });
                        if (snapshot.status !== 'ok'
                            || snapshot.jobObservations?.find(job => job.name === jobName)?.state === 'unavailable') {
                            throw terminationIncompleteError();
                        }
                        // The handshake PID may have been recycled. Signal only
                        // the current Job member with a verified birth identity.
                        const row = snapshot.rows.find(row => row.pid === targetPid && row.jobs?.includes(jobName));
                        target = row ? { pid: row.pid, start: row.start } : undefined;
                    }
                    if (target || !hostedJobFacts) {
                        const requested = await terminateProcessTree({ targets: target ? [target] : [],
                            tree: false, captureDescendants: true, waitForExit: false });
                        if (requested.status === 'unavailable' || requested.outcomes.some(row => row.outcome === 'refused')) {
                            throw terminationIncompleteError();
                        }
                        capturedTargets = requested.capturedTargets;
                        await observedPromise;
                    }
                }
                // Known subtree or exclusive custody still needs the canonical
                // terminator's absence proof even after the launcher exits.
                if (!input.terminateProcessTree && !input.processCustody && capturedTargets?.length) {
                    const result = await terminateProcessTree({ targets: capturedTargets, tree: false, ...terminationOptions() });
                    if (result.status !== 'complete') throw terminationIncompleteError();
                } else if (!input.terminateProcessTree && !input.processCustody && observed && capturedTreeOnOutput) {
                    const captured = await capturedTreeOnOutput;
                    if (captured.status === 'ok') {
                        const result = await terminateProcessTree({ targets: captured.capturedTargets, tree: false, ...terminationOptions() });
                        if (result.status !== 'complete') throw terminationIncompleteError();
                    }
                    // Exact known identities do not authorize discovering peers
                    // from a missing root. Unknown group members still refuse.
                    await terminate(child);
                } else await terminate(child);
                await observedPromise;
                confirmSettlement();
            })();
            // Only an explicit caller budget can end observation before native
            // cleanup. A default phase deadline would reject next-turn setup
            // while the same cleanup still owns the process.
            void joined.catch(() => undefined);
            let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
            let joinedBeforeDeadline: boolean;
            try {
                const joinTimeoutMs = input.terminationJoinTimeoutMs;
                joinedBeforeDeadline = joinTimeoutMs === undefined
                    ? await joined.then(() => true)
                    : await Promise.race([
                        joined.then(() => true),
                        new Promise<false>((resolve) => {
                            timeoutHandle = setTimeout(() => resolve(false), Math.max(1, joinTimeoutMs));
                            timeoutHandle.unref?.();
                        }),
                    ]);
            } catch (error) {
                if (!observed && (child.exitCode !== null || child.signalCode !== null)) {
                    freezeObserved(observedTermination(child.exitCode, child.signalCode));
                }
                throw terminationIncompleteError(error);
            } finally {
                if (timeoutHandle) clearTimeout(timeoutHandle);
            }
            if (!joinedBeforeDeadline) {
                // A join deadline is a bounded caller wait, not evidence that
                // the OS-owned containment is absent. Keep host-private custody
                // even when the root process itself already exited.
                throw terminationIncompleteError();
            }
        })();
        terminationPromise = attempt;
        void attempt.catch((error: unknown) => {
            if (terminationPromise === attempt) {
                terminationPromise = null;
            }
            if (!settled) {
                uncertain = error;
                for (const listener of [...uncertaintyListeners]) {
                    try { listener(error); } catch { /* Observers do not own process custody. */ }
                }
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
    // The launch preamble belongs to the Agent's start; an adopted Agent already consumed it.
    if (input.stdinPreamble !== undefined && holder?.kind !== 'adopt') {
        child.stdin.write(input.stdinPreamble);
    }
    if (input.stdin !== undefined) {
        child.stdin.end(input.stdin);
    }

    const dispose = (reason: DisposeReason = 'caller', options?: Readonly<{ beforeTerminate?: SupervisedPluginGracefulStop }>): Promise<void> => {
        // A new explicit Stop may arrive from the uncertainty observer before
        // the previous disposal's rejection reaches its outer cleanup. Join a
        // successful attempt, but retry THIS request after a failed attempt;
        // the first caller still observes its original unconfirmed outcome.
        if (disposePromise) return disposePromise.catch(() => dispose(reason, options));
        const attempt = (async () => {
            for (const signal of input.signals ?? []) {
                signal.removeEventListener('abort', abort);
            }
            if (timeout) {
                clearTimeout(timeout);
                timeout = null;
            }
            await requestTermination({ kind: 'dispose', reason }, options?.beforeTerminate);
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
            await writeStdin(data);
        },
        async closeStdin() {
            // A finite child can exit before an asynchronous caller closes input.
            // Ending an already destroyed stream can reject or never call back.
            if (child.stdin.destroyed || child.stdin.writableEnded) return;
            await new Promise<void>((resolve, reject) => {
                // The OS can also destroy stdin while end's finalization is
                // pending. Closing input carries no bytes; the child's result
                // remains authoritative for whether the finite command worked.
                child.stdin.end((error?: NodeJS.ErrnoException | null) => {
                    if (error && error.code !== 'ERR_STREAM_DESTROYED') reject(error);
                    else resolve();
                });
            });
        },
        waitForExit: () => observedPromise,
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
    // An adopted Agent's replay and any exit that happened while no runner was
    // attached are delivered only now that every listener above is wired.
    if (holder?.kind === 'adopt') (child as SessionHolderChild).resumeDelivery();
    return Object.freeze({
        child,
        handle,
        readBufferedStderr: () => new Uint8Array(Buffer.concat(stderrChunks, stderrBytes)),
        requestTermination,
        dispose,
        waitForSettlement: () => settlementPromise,
        onOutcomeUncertain(listener: (error: unknown) => void) {
            if (settled) return () => {};
            uncertaintyListeners.add(listener);
            if (uncertain !== undefined) {
                try { listener(uncertain); } catch { /* Observers do not own process custody. */ }
            }
            return () => { uncertaintyListeners.delete(listener); };
        },
    });
}
