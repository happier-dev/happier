import { spawn } from 'child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, relative, sep } from 'path';
import path, { delimiter as PATH_DELIMITER } from 'node:path';
import { accessSync, closeSync, constants as fsConstants, openSync, realpathSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { createScmCapabilities } from '@happier-dev/protocol/scm/capabilities';
import type { ScmWorkingSnapshot } from '@happier-dev/protocol/scm';
import type { BackendCommandRunInput, BackendCommandStreamInput } from '@happier-dev/plugin-sdk/scm/backend';
import { resolveBackendCommandMaxOutputBytes } from '@happier-dev/plugin-sdk/scm/backend';
import { resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';
import type { ExecService } from '@happier-dev/plugin-sdk/exec';
import type { HostAgentIsolationLaunchContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';

import { validatePath } from '@/rpc/handlers/pathSecurity';
import {
    OS_USER_FILESYSTEM_ACCESS_POLICY,
    type FilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { isSpawnWorkingDirectoryMissing } from '@/processes/spawnFailure/classifySpawnFailure';

import { resolveScmCommandOperationInput } from './commandOperation';
import { observeScmCommandResult, type ScmExecResult } from './commandDiagnostics';

export type { ScmExecResult } from './commandDiagnostics';

/** A failed execution authority is not evidence that the directory is not a repo. */
export class ScmExecUnavailableError extends Error {
    readonly code = 'scm_exec_unavailable';
    constructor() { super('scm_exec_unavailable'); }
}

const SCM_INSTALLABLE_KEYS = {
    git: 'dep.git',
    sl: 'dep.sapling',
} as const;

function resolveScmMaxOutputBytes(inputMaxOutputBytes: number | undefined): number {
    return resolveBackendCommandMaxOutputBytes({
        inputMaxOutputBytes,
        envValue: process.env.HAPPIER_SCM_MAX_OUTPUT_BYTES,
    });
}

type ChildStdinLike = {
    writable?: boolean;
    destroyed?: boolean;
    once?: (event: 'error', listener: (error: unknown) => void) => void;
    write: (chunk: string) => void;
    end: () => void;
};

function writeChildStdin(childStdin: ChildStdinLike | null | undefined, stdin: string | undefined, close = true): void {
    if (!childStdin) return;
    childStdin.once?.('error', () => {
        // Best-effort: stdin can be closed if command exits early.
    });
    if (childStdin.destroyed) return;

    try {
        if (stdin !== undefined) {
            childStdin.write(stdin);
        }
    } catch {
        return;
    }

    if (!close || childStdin.destroyed || childStdin.writable === false) return;
    try {
        childStdin.end();
    } catch {
        // Best-effort cleanup.
    }
}

function resolveScmInstallableKey(command: string, installableKey?: string): string {
    return installableKey ?? SCM_INSTALLABLE_KEYS[command as keyof typeof SCM_INSTALLABLE_KEYS] ?? `dep.${command}`;
}

function isSafeScmCommandName(command: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(command);
}

function resolveSystemScmBinPath(command: string, env: NodeJS.ProcessEnv): string | null {
    if (!isSafeScmCommandName(command)) return null;
    if (process.platform === 'win32') {
        return resolveWindowsCommandOnPath(command, env);
    }

    const pathRaw = typeof env.PATH === 'string' ? env.PATH.trim() : '';
    if (!pathRaw) return null;

    for (const dir of pathRaw.split(PATH_DELIMITER).map((entry) => entry.trim()).filter(Boolean)) {
        const candidate = path.join(dir, command);
        try {
            accessSync(candidate, fsConstants.X_OK);
            return candidate;
        } catch {
            // Keep searching PATH entries.
        }
    }

    return null;
}

export type ScmCommandInput = {
    bin: string;
    installableKey?: string;
    cwd: string;
    args: string[];
    timeoutMs?: number;
    stdin?: string;
    stdinInteraction?: BackendCommandRunInput['stdinInteraction'];
    maxOutputBytes?: number;
    env?: Record<string, string | undefined>;
    signal?: AbortSignal;
    stdoutConsumer?: BackendCommandStreamInput['stdoutConsumer'];
    /** Internal host-owned output file; exclusive creation, without collecting stdout. */
    stdoutFilePath?: string;
};

/** Host-private process port; the existing Exec owner decides identity and custody. */
export type ScmCommandRunner = (input: ScmCommandInput) => Promise<ScmExecResult>;

const scmCommandRunner = new AsyncLocalStorage<ScmCommandRunner>();

export function runWithScmCommandRunner<T>(runner: ScmCommandRunner | undefined, run: () => T): T {
    return runner ? scmCommandRunner.run(runner, run) : run();
}

export function readScmCommandRunner(): ScmCommandRunner | undefined {
    return scmCommandRunner.getStore();
}

/** Daemon callers consume the same held policy through the incumbent Exec owner. */
export function createHostScmCommandRunner(input: Readonly<{
    agentIsolation: HostAgentIsolationLaunchContext;
    isCurrent(): boolean;
    assertLaunchCurrent?(signal: AbortSignal): Promise<void>;
}>): ScmCommandRunner {
    return async command => {
        if (!resolveSystemScmBinPath(command.bin, process.env)) {
            return { success: false, stdout: '', exitCode: -1, executableMissing: true,
                stderr: `SCM executable not found for ${resolveScmInstallableKey(command.bin, command.installableKey)} (${command.bin})` };
        }
        const { createStablePluginExecService } = await import('@/plugins/runtime/invocation/services/exec');
        const environment = Object.fromEntries(Object.entries({ ...process.env, ...command.env })
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
        const exec = createStablePluginExecService({
            environment, signal: command.signal ?? new AbortController().signal,
            isOccurrenceCurrent: input.isCurrent, agentIsolation: input.agentIsolation,
            assertLaunchCurrent: input.assertLaunchCurrent,
            async resolvePath() { throw new Error('SCM requires an absolute working directory'); },
            async resolveExecutable() { throw new Error('SCM requires a resolved system tool'); },
            systemTools: { async resolve(request) {
                const executablePath = resolveSystemScmBinPath(request.toolId, process.env);
                if (!executablePath) throw Object.assign(new Error('SCM executable is unavailable'), { code: 'scm_executable_missing' });
                return { grantId: `scm:${request.toolId}`, toolId: request.toolId, displayName: request.toolId,
                    source: 'system', executablePath, launch: { kind: 'binary', executablePath } };
            } },
        });
        return createScmCommandRunnerFromExecService(exec)(command);
    };
}

/** Adapt streams only; identity, launch authorization and process custody stay at Exec. */
export function createScmCommandRunnerFromExecService(exec: ExecService): ScmCommandRunner {
    return async input => {
        if (input.stdoutFilePath && (input.stdoutConsumer || input.stdinInteraction)) {
            return { success: false, stdout: '', stderr: 'SCM stdout file cannot be combined with a stdout consumer or interaction', exitCode: -1 };
        }
        const tool = await exec.systemTools.resolve({ toolId: input.bin, purpose: 'scm', cwd: input.cwd, signal: input.signal });
        const maxOutputBytes = resolveScmMaxOutputBytes(input.maxOutputBytes);
        const cancellation = new AbortController();
        const abort = () => cancellation.abort();
        input.signal?.addEventListener('abort', abort, { once: true });
        if (input.signal?.aborted) abort();
        let descriptor: number | undefined;
        let timedOut = false;
        let outputLimitExceeded = false;
        let stoppedEarly = false;
        let interactionStarted = false;
        let interactionResponded = false;
        let finished = false;
        let pendingLine = '';
        let stdout = '';
        let stderr = '';
        let streamError = '';
        let bytes = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            if (input.stdoutFilePath) descriptor = openSync(input.stdoutFilePath, 'wx', 0o600);
            const child = await exec.spawn({ executable: tool.executable, args: input.args, cwd: input.cwd,
                env: Object.fromEntries(Object.entries(input.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
                maxStdoutBytes: 0, maxStderrBytes: 0,
            }, { signal: cancellation.signal });
            if (input.timeoutMs !== undefined) {
                timer = setTimeout(() => { timedOut = true; abort(); }, input.timeoutMs);
            }
            const subscription = child.onOutput(chunk => {
                if (finished || stoppedEarly || outputLimitExceeded || streamError) return;
                const buffer = Buffer.from(chunk.data);
                // File output is streamed to the host-owned descriptor, as in the
                // incumbent direct path; only stderr consumes the capture budget.
                if (chunk.stream === 'stdout' && descriptor !== undefined) {
                    try { writeSync(descriptor, buffer); } catch (error) {
                        streamError = error instanceof Error ? error.message : String(error); abort();
                    }
                    return;
                }
                const remaining = Math.max(0, maxOutputBytes - bytes);
                const admitted = buffer.subarray(0, remaining);
                bytes += admitted.length;
                if (chunk.stream === 'stderr') stderr += admitted.toString();
                else {
                    try {
                        if (input.stdoutConsumer) {
                            if (input.stdoutConsumer(admitted) === 'stop') { stoppedEarly = true; abort(); }
                        } else stdout += admitted.toString();
                        const interaction = input.stdinInteraction;
                        if (interaction && !interactionStarted) {
                            pendingLine += admitted.toString();
                            let newline: number;
                            while ((newline = pendingLine.indexOf('\n')) >= 0) {
                                const line = pendingLine.slice(0, newline).replace(/\r$/, '');
                                pendingLine = pendingLine.slice(newline + 1);
                                if (line !== interaction.readyLine) continue;
                                interactionStarted = true;
                                void Promise.resolve().then(() => finished || cancellation.signal.aborted ? undefined : interaction.respond())
                                    .then(async response => {
                                        if (response === undefined || finished || cancellation.signal.aborted) return;
                                        await child.write(Buffer.from(response));
                                        interactionResponded = true;
                                        await child.closeStdin();
                                    }).catch(error => {
                                        if (finished) return;
                                        streamError = error instanceof Error ? error.message : String(error);
                                        void child.closeStdin();
                                    });
                                break;
                            }
                        }
                    } catch (error) { streamError = error instanceof Error ? error.message : String(error); abort(); }
                }
                if (buffer.length > remaining && !stoppedEarly) {
                    outputLimitExceeded = true;
                    stderr += `\nSCM command output limit exceeded (${maxOutputBytes} bytes)`;
                    abort();
                }
            });
            try {
                if (input.stdin !== undefined) await child.write(Buffer.from(input.stdin));
                if (!input.stdinInteraction) await child.closeStdin();
                const result = await child.wait();
                finished = true;
                const observed = result.termination.observed;
                const exitCode = observed.kind === 'exit' ? observed.exitCode : -1;
                const aborted = input.signal?.aborted === true;
                return { success: (exitCode === 0 || stoppedEarly) && !timedOut && !aborted && !outputLimitExceeded
                        && !streamError && (!input.stdinInteraction || interactionResponded),
                    stdout, stderr: [stderr, streamError || (observed.kind === 'failed' ? observed.diagnostic.code : '')
                        || (aborted ? 'SCM command was aborted' : '')].filter(Boolean).join('\n'),
                    exitCode: input.stdinInteraction && (aborted || timedOut) ? -1 : exitCode,
                    timedOut, aborted, outputLimitExceeded,
                    ...(observed.kind === 'signal' ? { signal: observed.signal } : {}),
                    ...(input.stdoutConsumer ? { stoppedEarly } : {}),
                };
            } finally { finished = true; subscription.dispose(); await child.dispose(); }
        } finally {
            clearTimeout(timer);
            input.signal?.removeEventListener('abort', abort);
            if (descriptor !== undefined) closeSync(descriptor);
        }
    };
}

export function runScmCommand(input: ScmCommandInput): Promise<ScmExecResult> {
    input = resolveScmCommandOperationInput(input);
    const startedAt = performance.now();
    const runner = readScmCommandRunner();
    const command = runner ? runner(input) : runHostScmCommand(input);
    return command.then(result => observeScmCommandResult(input, result, startedAt));
}

function runHostScmCommand(input: ScmCommandInput): Promise<ScmExecResult> {
    const execEnv = input.env ? { ...process.env, ...input.env } : process.env;
    const resolvedBinPath = resolveSystemScmBinPath(input.bin, execEnv);
    if (!resolvedBinPath) {
        const installableKey = resolveScmInstallableKey(input.bin, input.installableKey);
        return Promise.resolve({
            success: false,
            stdout: '',
            stderr: `SCM executable not found for ${installableKey} (${input.bin})`,
            exitCode: -1,
            executableMissing: true,
        });
    }

    if (input.signal?.aborted) {
        return Promise.resolve({
            success: false,
            stdout: '',
            stderr: 'SCM command was aborted',
            exitCode: -1,
            aborted: true,
        });
    }

    if (input.stdoutFilePath && (input.stdoutConsumer || input.stdinInteraction)) {
        return Promise.resolve({ success: false, stdout: '',
            stderr: 'SCM stdout file cannot be combined with a stdout consumer or interaction', exitCode: -1 });
    }

    return new Promise((resolvePromise) => {
        let stdoutDescriptor: number | undefined;
        let child: ReturnType<typeof spawn>;
        try {
            if (input.stdoutFilePath) stdoutDescriptor = openSync(input.stdoutFilePath, 'wx', 0o600);
            child = spawn(resolvedBinPath, input.args, {
                cwd: input.cwd,
                env: execEnv,
                stdio: ['pipe', stdoutDescriptor ?? 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (error) {
            if (stdoutDescriptor !== undefined) closeSync(stdoutDescriptor);
            resolvePromise({ success: false, stdout: '',
                stderr: error instanceof Error ? error.message : String(error), exitCode: -1,
                ...(isSpawnWorkingDirectoryMissing(input.cwd) ? { workingDirectoryMissing: true as const } : {}) });
            return;
        }

        let stdout = '';
        let stderr = '';
        let resolved = false;
        let timedOut = false;
        let outputLimitExceeded = false;
        let aborted = false;
        let terminationRequested = false;
        let terminationSettled = false;
        let stoppedEarly = false;
        let streamError = '';
        let closedResult: ScmExecResult | null = null;
        let outputBytes = 0;
        let interactionStarted = false;
        let interactionResponded = false;
        let interactionError = '';
        let pendingStdoutLine = '';
        const timeoutMs = input.timeoutMs;
        const maxOutputBytes = resolveScmMaxOutputBytes(input.maxOutputBytes);

        const done = (result: ScmExecResult) => {
            if (resolved) return;
            resolved = true;
            input.signal?.removeEventListener('abort', abort);
            if (stdoutDescriptor !== undefined) {
                try { closeSync(stdoutDescriptor); }
                catch (error) {
                    result = { ...result, success: false,
                        stderr: [result.stderr, error instanceof Error ? error.message : String(error)].filter(Boolean).join('\n') };
                }
                stdoutDescriptor = undefined;
            }
            resolvePromise(result);
        };

        const finishClosedResult = () => {
            if (!closedResult) return;
            if (terminationRequested && !terminationSettled) return;
            done(aborted ? { ...closedResult, success: false,
                stderr: closedResult.stderr || 'SCM command was aborted' } : closedResult);
        };

        const terminate = () => {
            if (terminationRequested) return;
            terminationRequested = true;
            void terminateProcessTree(child).then(
                () => {
                    terminationSettled = true;
                    finishClosedResult();
                },
                (error: unknown) => {
                    terminationSettled = true;
                    done({
                        success: false,
                        stdout,
                        stderr: error instanceof Error ? error.message : 'SCM command was aborted',
                        exitCode: -1,
                        timedOut,
                        outputLimitExceeded,
                    });
                },
            );
        };

        const abort = () => {
            if (aborted || resolved) return;
            aborted = true;
            if (input.stdinInteraction) writeChildStdin(child.stdin, undefined);
            terminate();
        };

        const stop = () => {
            if (stoppedEarly || resolved || aborted || timedOut || outputLimitExceeded) return;
            stoppedEarly = true;
            clearTimeout(timer);
            terminate();
        };

        const appendOutput = (channel: 'stdout' | 'stderr', chunk: Buffer) => {
            if (outputLimitExceeded || stoppedEarly || aborted) return;

            const remaining = maxOutputBytes - outputBytes;
            if (channel === 'stdout' && input.stdoutConsumer && remaining > 0) {
                // The existing byte boundary admits only this prefix. A read
                // settled within it need not inspect older output in the chunk.
                const admitted = chunk.subarray(0, remaining);
                outputBytes += admitted.length;
                try {
                    if (input.stdoutConsumer(admitted) === 'stop') {
                        stop();
                        return;
                    }
                } catch (error) {
                    streamError = error instanceof Error ? error.message : String(error);
                    stop();
                    return;
                }
                if (chunk.length <= remaining) return;
            }
            if (remaining <= 0) {
                outputLimitExceeded = true;
                stderr += `\nSCM command output limit exceeded (${maxOutputBytes} bytes)`;
                if (input.stdinInteraction || input.stdoutConsumer || input.stdoutFilePath) abort();
                else child.kill('SIGKILL');
                return;
            }

            if (chunk.length > remaining) {
                const slice = chunk.subarray(0, remaining);
                if (channel === 'stdout' && !input.stdoutConsumer) {
                    stdout += slice.toString();
                } else if (channel === 'stderr') {
                    stderr += slice.toString();
                }
                outputBytes = maxOutputBytes;
                outputLimitExceeded = true;
                stderr += `\nSCM command output limit exceeded (${maxOutputBytes} bytes)`;
                if (input.stdinInteraction || input.stdoutConsumer || input.stdoutFilePath) abort();
                else child.kill('SIGKILL');
                return;
            }

            if (channel === 'stdout') {
                stdout += chunk.toString();
            } else {
                stderr += chunk.toString();
            }
            outputBytes += chunk.length;
        };

        const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
            timedOut = true;
            if (input.stdinInteraction || input.stdoutConsumer || input.stdoutFilePath) abort();
            else child.kill('SIGKILL');
        }, timeoutMs);

        const observeInteraction = (chunk: Buffer) => {
            const interaction = input.stdinInteraction;
            if (!interaction || interactionStarted || resolved || stoppedEarly || aborted || timedOut || outputLimitExceeded) return;
            pendingStdoutLine += chunk.toString();
            let newline: number;
            while ((newline = pendingStdoutLine.indexOf('\n')) >= 0) {
                const line = pendingStdoutLine.slice(0, newline).replace(/\r$/, '');
                pendingStdoutLine = pendingStdoutLine.slice(newline + 1);
                if (line !== interaction.readyLine) continue;
                interactionStarted = true;
                void Promise.resolve().then(() => {
                    if (resolved || closedResult || aborted || timedOut || outputLimitExceeded) return;
                    return interaction.respond();
                }).then((response) => {
                    if (response === undefined || resolved || closedResult || aborted || timedOut || outputLimitExceeded) return;
                    interactionResponded = true;
                    writeChildStdin(child.stdin, response);
                }, (error: unknown) => {
                    if (resolved || closedResult || aborted || timedOut || outputLimitExceeded) return;
                    interactionError = error instanceof Error ? error.message : String(error);
                    // EOF lets the command abort its prepared transaction and release native locks.
                    writeChildStdin(child.stdin, undefined);
                });
                break;
            }
        };

        child.stdout?.on('data', (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            appendOutput('stdout', buffer);
            observeInteraction(buffer);
        });

        child.stderr?.on('data', (chunk) => {
            appendOutput('stderr', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        child.on('error', (error) => {
            clearTimeout(timer);
            done({
                success: false,
                stdout,
                stderr: error.message,
                exitCode: -1,
                timedOut,
                outputLimitExceeded,
                ...(isSpawnWorkingDirectoryMissing(input.cwd) ? { workingDirectoryMissing: true as const } : {}),
            });
        });

        child.on('close', (exitCode, signal) => {
            clearTimeout(timer);
            const code = typeof exitCode === 'number' ? exitCode : -1;
            closedResult = {
                success: (code === 0 || stoppedEarly) && !timedOut && !outputLimitExceeded && !aborted
                    && !streamError && !interactionError && (!input.stdinInteraction || interactionResponded),
                stdout,
                stderr: streamError ? [stderr, streamError].filter(Boolean).join('\n')
                    : interactionError ? [stderr, interactionError].filter(Boolean).join('\n')
                    : aborted && !stderr ? 'SCM command was aborted' : stderr,
                // Cancellation can race a successful publication; callers must resolve the outcome.
                exitCode: input.stdinInteraction && aborted ? -1 : code,
                timedOut,
                aborted,
                ...(signal ? { signal } : {}),
                outputLimitExceeded,
                ...(input.stdoutConsumer ? { stoppedEarly } : {}),
            };
            finishClosedResult();
        });

        input.signal?.addEventListener('abort', abort, { once: true });
        if (input.signal?.aborted) abort();
        writeChildStdin(child.stdin, input.stdin, !input.stdinInteraction);
    });
}

/**
 * Availability probe for a declared SCM runtime dependency. It reuses the one
 * command resolution and spawn owner above, so a missing executable, an
 * unusable one, and a failing invocation are reported through the same path.
 */
export async function probeScmExecutableAvailable(input: {
    bin: string;
    installableKey?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
}): Promise<boolean> {
    const result = await runScmCommand({
        bin: input.bin,
        ...(input.installableKey === undefined ? {} : { installableKey: input.installableKey }),
        // `--version` never reads a repository, so the probe stays outside any
        // workspace root that could be renamed or removed beneath it.
        cwd: tmpdir(),
        args: ['--version'],
        timeoutMs: input.timeoutMs ?? 10_000,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return result.success;
}

export function resolveCwd(
    rawCwd: string | undefined,
    workingDirectory: string,
    accessPolicy: FilesystemAccessPolicy = OS_USER_FILESYSTEM_ACCESS_POLICY,
): { ok: true; cwd: string } | { ok: false; error: string } {
    const normalizedWorkingDirectory = resolveTildePath(workingDirectory);
    if (!rawCwd) return { ok: true, cwd: normalizedWorkingDirectory };

    const normalizedRawCwd = rawCwd.trim().startsWith('~') ? resolveTildePath(rawCwd) : rawCwd;
    const validation = validatePath(normalizedRawCwd, normalizedWorkingDirectory, undefined, accessPolicy);
    if (!validation.valid || !validation.resolvedPath) {
        return { ok: false, error: validation.error || `Invalid path: ${rawCwd}` };
    }
    return { ok: true, cwd: validation.resolvedPath };
}

export function normalizePathspec(rawPath: string, cwd: string): { ok: true; pathspec: string } | { ok: false; error: string } {
    const canonicalCwd = (() => {
        try {
            return realpathSync(path.resolve(cwd));
        } catch {
            return path.resolve(cwd);
        }
    })();

    const validation = validatePath(rawPath, canonicalCwd);
    if (!validation.valid || !validation.resolvedPath) {
        return { ok: false, error: validation.error || `Invalid path: ${rawPath}` };
    }
    const rel = relative(canonicalCwd, validation.resolvedPath);
    if (rel === '' || rel === '.') {
        return { ok: true, pathspec: '.' };
    }
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return { ok: false, error: `Path outside working directory: ${rawPath}` };
    }
    return { ok: true, pathspec: rel.split(sep).join('/') };
}

export function normalizeRepoRootRelativePath(
    rawPath: string
): { ok: true; relativePath: string; pathspec: string } | { ok: false; error: string } {
    const requestedPath = String(rawPath ?? '');
    if (!requestedPath.trim()) {
        return { ok: false, error: 'Path cannot be empty' };
    }
    if (requestedPath.includes('\0')) {
        return { ok: false, error: 'Path contains null bytes' };
    }
    if (requestedPath.startsWith('-')) {
        return { ok: false, error: 'Path cannot start with "-"' };
    }
    if (requestedPath.startsWith(':')) {
        // Prevent injecting git pathspec magic like :(icase) or :(exclude)
        return { ok: false, error: 'Path contains unsupported syntax' };
    }
    if (isAbsolute(requestedPath)) {
        return { ok: false, error: 'Absolute paths are not supported' };
    }

    const normalized = requestedPath.split(sep).join('/').replace(/^\.\/+/, '').replace(/^\/+/, '');
    const parts = normalized.split('/');
    if (parts.some((part) => part === '..')) {
        return { ok: false, error: `Path contains unsupported ".." segment: ${rawPath}` };
    }
    if (!normalized || normalized === '.') {
        return { ok: true, relativePath: '.', pathspec: ':(top).' };
    }
    return { ok: true, relativePath: normalized, pathspec: `:(top)${normalized}` };
}

// The UI sends repo-root-relative paths (from status snapshots), but sessions can run from subdirectories.
// Use git pathspec magic to anchor the path to the repository top-level so diffs work from any cwd.
export function normalizeRepoRootPathspec(rawPath: string): { ok: true; pathspec: string } | { ok: false; error: string } {
    const normalized = normalizeRepoRootRelativePath(rawPath);
    if (!normalized.ok) return normalized;
    return { ok: true, pathspec: normalized.pathspec };
}

const SAFE_COMMIT_REF_REGEX = /^(?:[0-9a-fA-F]{7,64}|[A-Za-z0-9._/-]+)$/;

export function normalizeCommitRef(rawCommit: string): { ok: true; commit: string } | { ok: false; error: string } {
    const commit = rawCommit.trim();
    if (!commit) {
        return { ok: false, error: 'Commit reference cannot be empty' };
    }
    if (/\s/.test(commit)) {
        return { ok: false, error: 'Commit reference must not contain whitespace' };
    }
    if (commit.startsWith('-')) {
        return { ok: false, error: 'Commit reference cannot start with "-"' };
    }
    if (commit.startsWith('.') || commit.startsWith('/')) {
        return { ok: false, error: 'Commit reference contains unsupported syntax' };
    }
    if (commit.includes('..') || commit.includes('@{') || commit.includes(':')) {
        return { ok: false, error: 'Commit reference contains unsupported syntax' };
    }
    if (!SAFE_COMMIT_REF_REGEX.test(commit)) {
        return { ok: false, error: 'Commit reference contains invalid characters' };
    }
    return { ok: true, commit };
}

export function createNonRepositorySnapshot(input: {
    projectKey: string;
    fetchedAt: number;
}): ScmWorkingSnapshot {
    return {
        projectKey: input.projectKey,
        fetchedAt: input.fetchedAt,
        repo: {
            isRepo: false,
            rootPath: null,
            backendId: null,
            mode: null,
            worktrees: [],
            remotes: [],
        },
        capabilities: createScmCapabilities(),
        branch: {
            head: null,
            upstream: null,
            ahead: 0,
            behind: 0,
            detached: false,
        },
        stashCount: 0,
        hasConflicts: false,
        entries: [],
        totals: {
            includedFiles: 0,
            pendingFiles: 0,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 0,
            pendingRemoved: 0,
        },
    };
}

export function resolveTildePath(
    inputPath: string,
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): string {
    return expandHomeDirPath(inputPath.trim(), env, platform);
}
