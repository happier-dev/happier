import { spawn } from 'child_process';
import { isAbsolute, relative, sep } from 'path';
import path, { delimiter as PATH_DELIMITER } from 'node:path';
import { accessSync, constants as fsConstants, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { createScmCapabilities } from '@happier-dev/protocol/scm/capabilities';
import type { ScmWorkingSnapshot } from '@happier-dev/protocol/scm';
import type { BackendCommandRunInput } from '@happier-dev/plugin-sdk/scm/backend';
import { resolveWindowsCommandOnPath } from '@happier-dev/cli-common/process';

import { validatePath } from '@/rpc/handlers/pathSecurity';
import {
    OS_USER_FILESYSTEM_ACCESS_POLICY,
    type FilesystemAccessPolicy,
} from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';

export type ScmExecResult = {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
    outputLimitExceeded?: boolean;
};

const DEFAULT_SCM_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const SCM_INSTALLABLE_KEYS = {
    git: 'dep.git',
    sl: 'dep.sapling',
} as const;

function resolveScmMaxOutputBytes(inputMaxOutputBytes: number | undefined): number {
    if (typeof inputMaxOutputBytes === 'number' && Number.isFinite(inputMaxOutputBytes) && inputMaxOutputBytes > 0) {
        return Math.floor(inputMaxOutputBytes);
    }

    const envValue = process.env.HAPPIER_SCM_MAX_OUTPUT_BYTES;
    if (!envValue) return DEFAULT_SCM_MAX_OUTPUT_BYTES;
    const parsed = Number(envValue);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_SCM_MAX_OUTPUT_BYTES;
    }
    return Math.floor(parsed);
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

export function runScmCommand(input: {
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
}): Promise<ScmExecResult> {
    const execEnv = input.env ? { ...process.env, ...input.env } : process.env;
    const resolvedBinPath = resolveSystemScmBinPath(input.bin, execEnv);
    if (!resolvedBinPath) {
        const installableKey = resolveScmInstallableKey(input.bin, input.installableKey);
        return Promise.resolve({
            success: false,
            stdout: '',
            stderr: `SCM executable not found for ${installableKey} (${input.bin})`,
            exitCode: -1,
        });
    }

    if (input.signal?.aborted) {
        return Promise.resolve({
            success: false,
            stdout: '',
            stderr: 'SCM command was aborted',
            exitCode: -1,
        });
    }

    return new Promise((resolvePromise) => {
        const child = spawn(resolvedBinPath, input.args, {
            cwd: input.cwd,
            env: execEnv,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let resolved = false;
        let timedOut = false;
        let outputLimitExceeded = false;
        let aborted = false;
        let abortTerminationSettled = false;
        let closedResult: ScmExecResult | null = null;
        let outputBytes = 0;
        let interactionStarted = false;
        let interactionResponded = false;
        let interactionError = '';
        let pendingStdoutLine = '';
        const timeoutMs = input.timeoutMs ?? 15_000;
        const maxOutputBytes = resolveScmMaxOutputBytes(input.maxOutputBytes);

        const done = (result: ScmExecResult) => {
            if (resolved) return;
            resolved = true;
            input.signal?.removeEventListener('abort', abort);
            resolvePromise(result);
        };

        const finishClosedResult = () => {
            if (!closedResult) return;
            if (aborted && !abortTerminationSettled) return;
            done(closedResult);
        };

        const abort = () => {
            if (aborted || resolved) return;
            aborted = true;
            if (input.stdinInteraction) writeChildStdin(child.stdin, undefined);
            void killProcessTree(child).then(
                () => {
                    abortTerminationSettled = true;
                    finishClosedResult();
                },
                (error: unknown) => {
                    abortTerminationSettled = true;
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

        const appendOutput = (channel: 'stdout' | 'stderr', chunk: Buffer) => {
            if (outputLimitExceeded) return;

            const remaining = maxOutputBytes - outputBytes;
            if (remaining <= 0) {
                outputLimitExceeded = true;
                stderr += `\nSCM command output limit exceeded (${maxOutputBytes} bytes)`;
                if (input.stdinInteraction) abort();
                else child.kill('SIGKILL');
                return;
            }

            if (chunk.length > remaining) {
                const slice = chunk.subarray(0, remaining);
                if (channel === 'stdout') {
                    stdout += slice.toString();
                } else {
                    stderr += slice.toString();
                }
                outputBytes = maxOutputBytes;
                outputLimitExceeded = true;
                stderr += `\nSCM command output limit exceeded (${maxOutputBytes} bytes)`;
                if (input.stdinInteraction) abort();
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

        const timer = setTimeout(() => {
            timedOut = true;
            if (input.stdinInteraction) abort();
            else child.kill('SIGKILL');
        }, timeoutMs);

        const observeInteraction = (chunk: Buffer) => {
            const interaction = input.stdinInteraction;
            if (!interaction || interactionStarted || resolved || aborted || timedOut || outputLimitExceeded) return;
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

        child.stdout.on('data', (chunk) => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            appendOutput('stdout', buffer);
            observeInteraction(buffer);
        });

        child.stderr.on('data', (chunk) => {
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
            });
        });

        child.on('close', (exitCode) => {
            clearTimeout(timer);
            const code = typeof exitCode === 'number' ? exitCode : -1;
            closedResult = {
                success: code === 0 && !timedOut && !outputLimitExceeded && !aborted
                    && !interactionError && (!input.stdinInteraction || interactionResponded),
                stdout,
                stderr: interactionError ? [stderr, interactionError].filter(Boolean).join('\n')
                    : aborted && !stderr ? 'SCM command was aborted' : stderr,
                // Cancellation can race a successful publication; callers must resolve the outcome.
                exitCode: input.stdinInteraction && aborted ? -1 : code,
                timedOut,
                outputLimitExceeded,
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
