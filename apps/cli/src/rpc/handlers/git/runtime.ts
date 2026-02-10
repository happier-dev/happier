import { spawn } from 'child_process';
import { isAbsolute, relative, sep } from 'path';

import type { GitStatusSnapshotResponse, GitWorkingSnapshot } from '@happier-dev/protocol';
import { GIT_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { validatePath } from '../pathSecurity';
import { buildSnapshot, createEmptySnapshot } from './status';

export type GitExecResult = {
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number;
    timedOut?: boolean;
};

type ChildStdinLike = {
    writable?: boolean;
    destroyed?: boolean;
    once?: (event: 'error', listener: (error: unknown) => void) => void;
    write: (chunk: string) => void;
    end: () => void;
};

export function writeGitStdin(childStdin: ChildStdinLike | null | undefined, stdin: string | undefined): void {
    if (!childStdin) return;
    childStdin.once?.('error', () => {
        // Best-effort: stdin can be closed if git exits early.
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

export function runGitCommand(input: {
    cwd: string;
    args: string[];
    timeoutMs?: number;
    stdin?: string;
}): Promise<GitExecResult> {
    return new Promise((resolvePromise) => {
        const child = spawn('git', input.args, {
            cwd: input.cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });

        let stdout = '';
        let stderr = '';
        let resolved = false;
        let timedOut = false;
        const timeoutMs = input.timeoutMs ?? 15_000;

        const done = (result: GitExecResult) => {
            if (resolved) return;
            resolved = true;
            resolvePromise(result);
        };

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
        });

        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString();
        });

        child.on('error', (error) => {
            clearTimeout(timer);
            done({
                success: false,
                stdout,
                stderr: error.message,
                exitCode: -1,
                timedOut,
            });
        });

        child.on('close', (exitCode) => {
            clearTimeout(timer);
            const code = typeof exitCode === 'number' ? exitCode : -1;
            done({
                success: code === 0 && !timedOut,
                stdout,
                stderr,
                exitCode: code,
                timedOut,
            });
        });

        writeGitStdin(child.stdin, input.stdin);
    });
}

export function resolveCwd(
    rawCwd: string | undefined,
    workingDirectory: string
): { ok: true; cwd: string } | { ok: false; error: string } {
    if (!rawCwd) return { ok: true, cwd: workingDirectory };
    const validation = validatePath(rawCwd, workingDirectory);
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
    // Accept accidental leading/trailing whitespace (common when values come from UI/clipboard),
    // but reject internal whitespace since git rev specs can't contain it.
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

export function hasAnyWorktreeChanges(snapshot: GitWorkingSnapshot): boolean {
    return snapshot.entries.length > 0;
}

export async function getSnapshotForCwd(cwd: string, projectKey: string): Promise<GitStatusSnapshotResponse> {
    const fetchedAt = Date.now();
    const gitRepoCheck = await runGitCommand({
        cwd,
        args: ['rev-parse', '--is-inside-work-tree'],
        timeoutMs: 5000,
    });

    if (!gitRepoCheck.success || gitRepoCheck.exitCode !== 0) {
        return {
            success: true,
            snapshot: createEmptySnapshot(projectKey, fetchedAt),
        };
    }

    const rootResult = await runGitCommand({
        cwd,
        args: ['rev-parse', '--show-toplevel'],
        timeoutMs: 5000,
    });
    const statusResult = await runGitCommand({
        cwd,
        args: ['status', '--porcelain=v2', '-z', '--branch', '--show-stash', '--untracked-files=all'],
        timeoutMs: 10_000,
    });
    if (!statusResult.success) {
        return {
            success: false,
            errorCode: GIT_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: statusResult.stderr || 'Failed to read git status',
        };
    }

    const stagedResult = await runGitCommand({
        cwd,
        args: ['diff', '--cached', '--numstat', '-z'],
        timeoutMs: 10_000,
    });
    const unstagedResult = await runGitCommand({
        cwd,
        args: ['diff', '--numstat', '-z'],
        timeoutMs: 10_000,
    });

    return {
        success: true,
        snapshot: buildSnapshot({
            projectKey,
            fetchedAt,
            rootPath: rootResult.success ? rootResult.stdout.trim() : null,
            statusOutput: statusResult.stdout ?? '',
            stagedNumStatOutput: stagedResult.success ? (stagedResult.stdout ?? '') : '',
            unstagedNumStatOutput: unstagedResult.success ? (unstagedResult.stdout ?? '') : '',
        }),
    };
}
