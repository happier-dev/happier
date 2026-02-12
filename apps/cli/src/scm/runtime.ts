import { spawn } from 'child_process';
import { isAbsolute, relative, sep } from 'path';
import os from 'node:os';
import path from 'node:path';

import { createScmCapabilities, type ScmWorkingSnapshot } from '@happier-dev/protocol';

import { validatePath } from '@/rpc/handlers/pathSecurity';

export type ScmExecResult = {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
    outputLimitExceeded?: boolean;
};

const DEFAULT_SCM_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

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

function writeChildStdin(childStdin: ChildStdinLike | null | undefined, stdin: string | undefined): void {
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

    if (childStdin.destroyed || childStdin.writable === false) return;
    try {
        childStdin.end();
    } catch {
        // Best-effort cleanup.
    }
}

export function runScmCommand(input: {
    bin: 'git' | 'sl';
    cwd: string;
    args: string[];
    timeoutMs?: number;
    stdin?: string;
    maxOutputBytes?: number;
    env?: Record<string, string | undefined>;
}): Promise<ScmExecResult> {
    return new Promise((resolvePromise) => {
        const child = spawn(input.bin, input.args, {
            cwd: input.cwd,
            env: input.env ? { ...process.env, ...input.env } : process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let resolved = false;
        let timedOut = false;
        let outputLimitExceeded = false;
        let outputBytes = 0;
        const timeoutMs = input.timeoutMs ?? 15_000;
        const maxOutputBytes = resolveScmMaxOutputBytes(input.maxOutputBytes);

        const done = (result: ScmExecResult) => {
            if (resolved) return;
            resolved = true;
            resolvePromise(result);
        };

        const appendOutput = (channel: 'stdout' | 'stderr', chunk: Buffer) => {
            if (outputLimitExceeded) return;

            const remaining = maxOutputBytes - outputBytes;
            if (remaining <= 0) {
                outputLimitExceeded = true;
                stderr += `\nSCM command output limit exceeded (${maxOutputBytes} bytes)`;
                child.kill('SIGKILL');
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
                child.kill('SIGKILL');
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
            child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            appendOutput('stdout', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
            done({
                success: code === 0 && !timedOut && !outputLimitExceeded,
                stdout,
                stderr,
                exitCode: code,
                timedOut,
                outputLimitExceeded,
            });
        });

        writeChildStdin(child.stdin, input.stdin);
    });
}

export function resolveCwd(
    rawCwd: string | undefined,
    workingDirectory: string
): { ok: true; cwd: string } | { ok: false; error: string } {
    const normalizedWorkingDirectory = resolveTildePath(workingDirectory);
    if (!rawCwd) return { ok: true, cwd: normalizedWorkingDirectory };

    const normalizedRawCwd = rawCwd.trim().startsWith('~') ? resolveTildePath(rawCwd) : rawCwd;
    const validation = validatePath(normalizedRawCwd, normalizedWorkingDirectory);
    if (!validation.valid || !validation.resolvedPath) {
        return { ok: false, error: validation.error || `Invalid path: ${rawCwd}` };
    }
    return { ok: true, cwd: validation.resolvedPath };
}

export function normalizePathspec(rawPath: string, cwd: string): { ok: true; pathspec: string } | { ok: false; error: string } {
    const validation = validatePath(rawPath, cwd);
    if (!validation.valid || !validation.resolvedPath) {
        return { ok: false, error: validation.error || `Invalid path: ${rawPath}` };
    }
    const rel = relative(cwd, validation.resolvedPath);
    if (rel === '' || rel === '.') {
        return { ok: true, pathspec: '.' };
    }
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
        return { ok: false, error: `Path outside working directory: ${rawPath}` };
    }
    return { ok: true, pathspec: rel.split(sep).join('/') };
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

export function resolveTildePath(inputPath: string): string {
    const trimmed = inputPath.trim();
    const home = os.homedir();
    if (trimmed === '~') return home;
    if (trimmed.startsWith('~/')) return path.join(home, trimmed.slice(2));
    return inputPath;
}
