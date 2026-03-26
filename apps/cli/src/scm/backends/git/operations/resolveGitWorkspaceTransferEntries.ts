import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { ScmSourceControllerWorkspaceTransferInput } from '../../../types';
import {
    createScmSourceControllerWorkspaceTransferEntry,
    type ScmSourceControllerWorkspaceTransferEntry,
} from '../../../sourceController/workspaceTransfer';
import { runScmCommand } from '../../../runtime';
import { inspectGitCheckoutIdentity, isGitLinkedWorktreeIdentity } from '../checkoutIdentity';

function normalizeRelativePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

const DEFAULT_GIT_LS_FILES_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;

function resolveGitLsFilesMaxOutputBytes(): number {
    const rawEnv = process.env.HAPPIER_SCM_GIT_LS_FILES_MAX_OUTPUT_BYTES;
    if (!rawEnv) return DEFAULT_GIT_LS_FILES_MAX_OUTPUT_BYTES;
    const parsed = Number(rawEnv);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return DEFAULT_GIT_LS_FILES_MAX_OUTPUT_BYTES;
    }
    return Math.floor(parsed);
}

async function runGitNullSeparatedPathList(params: Readonly<{
    cwd: string;
    args: readonly string[];
    maxStdoutBytes?: number;
}>): Promise<readonly string[]> {
    const maxStdoutBytes = params.maxStdoutBytes ?? resolveGitLsFilesMaxOutputBytes();

    return await new Promise((resolvePromise, rejectPromise) => {
        const child = spawn('git', [...params.args], {
            cwd: params.cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: process.env,
        });

        const results: string[] = [];
        let stdoutBytes = 0;
        let stderr = '';
        // Node's Buffer type is generic over the backing ArrayBufferLike, but many
        // constructors return `Buffer<ArrayBuffer>` specifically. Since stream chunks
        // can be backed by either ArrayBuffer or SharedArrayBuffer, keep our internal
        // buffer types widened to `ArrayBufferLike` to avoid invariant generic
        // assignment issues.
        let remainder = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
        let settled = false;

        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            fn();
        };

        const appendStderr = (chunk: Buffer<ArrayBufferLike>) => {
            // Best-effort capture; stderr should stay small for these commands.
            if (stderr.length > 32_000) return;
            stderr += chunk.toString('utf8');
        };

        const parseStdoutChunk = (chunk: Buffer<ArrayBufferLike>) => {
            if (chunk.length === 0) {
                return;
            }

            let buffer = chunk;
            if (remainder.length > 0) {
                const merged = Buffer.allocUnsafe(remainder.length + chunk.length) as Buffer<ArrayBufferLike>;
                remainder.copy(merged, 0);
                chunk.copy(merged, remainder.length);
                buffer = merged;
                remainder = Buffer.alloc(0) as Buffer<ArrayBufferLike>;
            }

            let start = 0;
            for (let index = 0; index < buffer.length; index += 1) {
                if (buffer[index] !== 0) continue;
                if (index > start) {
                    const entry = normalizeRelativePath(buffer.subarray(start, index).toString('utf8'));
                    if (entry) {
                        results.push(entry);
                    }
                }
                start = index + 1;
            }

            if (start < buffer.length) {
                remainder = buffer.slice(start) as Buffer<ArrayBufferLike>;
            }
        };

        child.stdout.on('data', (raw) => {
            const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
            stdoutBytes += chunk.length;
            if (stdoutBytes > maxStdoutBytes) {
                try {
                    child.kill('SIGKILL');
                } catch {
                    // Best-effort.
                }
                settle(() => {
                    rejectPromise(new Error(`Git command output exceeded limit (${maxStdoutBytes} bytes)`));
                });
                return;
            }
            parseStdoutChunk(chunk);
        });

        child.stderr.on('data', (raw) => {
            appendStderr(Buffer.isBuffer(raw) ? raw : Buffer.from(raw));
        });

        child.on('error', (error) => {
            settle(() => rejectPromise(error));
        });

        child.on('close', (exitCode) => {
            if (settled) return;

            // Consume any trailing non-null-terminated bytes (git should terminate with NUL, but fail closed).
            if (remainder.length > 0) {
                const entry = normalizeRelativePath(remainder.toString('utf8'));
                if (entry) {
                    results.push(entry);
                }
            }

            const code = typeof exitCode === 'number' ? exitCode : -1;
            if (code !== 0) {
                settle(() => rejectPromise(new Error((stderr || `git exited with code ${code}`).trim())));
                return;
            }

            settle(() => resolvePromise(results));
        });
    });
}

async function listGitManagedPaths(sourcePath: string): Promise<readonly string[]> {
    return await runGitNullSeparatedPathList({
        cwd: sourcePath,
        args: ['-C', sourcePath, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.'],
    });
}

async function listSelectedIgnoredPaths(sourcePath: string, ignoredIncludeGlobs: readonly string[]): Promise<readonly string[]> {
    if (ignoredIncludeGlobs.length === 0) {
        return [];
    }

    return await runGitNullSeparatedPathList({
        cwd: sourcePath,
        args: [
            '-C',
            sourcePath,
            'ls-files',
            '-z',
            '--others',
            '-i',
            '--exclude-standard',
            '--',
            ...ignoredIncludeGlobs,
        ],
    });
}

async function resolveGitDirectoryPath(sourcePath: string): Promise<string | null> {
    const pathFormatAttempt = await runScmCommand({
        bin: 'git',
        cwd: sourcePath,
        args: ['rev-parse', '--path-format=absolute', '--git-dir'],
        timeoutMs: 5000,
        maxOutputBytes: 1024 * 1024,
    });

    if (pathFormatAttempt.success) {
        const gitDirectoryPath = pathFormatAttempt.stdout.trim();
        return gitDirectoryPath.length > 0 ? gitDirectoryPath : null;
    }

    const fallback = await runScmCommand({
        bin: 'git',
        cwd: sourcePath,
        args: ['rev-parse', '--git-dir'],
        timeoutMs: 5000,
        maxOutputBytes: 1024 * 1024,
    });
    const gitDirectoryPath = fallback.stdout.trim();
    if (!fallback.success || gitDirectoryPath.length === 0) {
        return null;
    }

    return isAbsolute(gitDirectoryPath) ? gitDirectoryPath : resolve(sourcePath, gitDirectoryPath);
}

async function walkDirectory(root: string, prefix = ''): Promise<string[]> {
    const { readdir } = await import('node:fs/promises');

    const entries = await readdir(root, { withFileTypes: true });
    const results: string[] = [];
    for (const entry of entries) {
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
        results.push(relativePath);
        if (entry.isDirectory()) {
            results.push(...await walkDirectory(join(root, entry.name), relativePath));
        }
    }
    return results;
}

function isPortableGitMetadataRelativePath(relativePath: string): boolean {
    return relativePath !== 'worktrees' && !relativePath.startsWith('worktrees/');
}

async function listGitMetadataEntries(sourcePath: string): Promise<readonly ScmSourceControllerWorkspaceTransferEntry[]> {
    const identity = await inspectGitCheckoutIdentity({ cwd: sourcePath });
    if (identity && isGitLinkedWorktreeIdentity(identity)) {
        return [];
    }

    const gitDirectoryPath = await resolveGitDirectoryPath(sourcePath);
    if (!gitDirectoryPath) {
        return [];
    }

    return (await walkDirectory(gitDirectoryPath))
        .filter(isPortableGitMetadataRelativePath)
        .map((relativePath) => ({
                relativePath: normalizeRelativePath(join('.git', relativePath)),
                sourcePath: join(gitDirectoryPath, relativePath),
        }))
        .map(createScmSourceControllerWorkspaceTransferEntry);
}

async function resolveCanonicalComparisonPath(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return resolve(path);
    }
}

async function shouldIncludeGitMetadataEntries(input: ScmSourceControllerWorkspaceTransferInput): Promise<boolean> {
    const repoRootPath = input.context.detection.rootPath;
    if (!repoRootPath) {
        return true;
    }

    const [canonicalCwdPath, canonicalRepoRootPath] = await Promise.all([
        resolveCanonicalComparisonPath(input.context.cwd),
        resolveCanonicalComparisonPath(repoRootPath),
    ]);
    return canonicalCwdPath === canonicalRepoRootPath;
}

export async function resolveGitWorkspaceTransferEntries(input: ScmSourceControllerWorkspaceTransferInput): Promise<readonly ScmSourceControllerWorkspaceTransferEntry[]> {
    const sourcePath = input.context.cwd;
    const relativePaths = new Set(await listGitManagedPaths(sourcePath));

    if (input.workspaceTransfer.includeIgnoredMode === 'include_selected') {
        for (const relativePath of await listSelectedIgnoredPaths(sourcePath, [...input.workspaceTransfer.ignoredIncludeGlobs])) {
            relativePaths.add(relativePath);
        }
    }

    const entries = [
        ...[...relativePaths]
            .sort((left, right) => left.localeCompare(right))
            .map((relativePath) => createScmSourceControllerWorkspaceTransferEntry({
                relativePath,
                sourcePath: join(sourcePath, relativePath),
            })),
        ...(await shouldIncludeGitMetadataEntries(input) ? await listGitMetadataEntries(sourcePath) : []),
    ];

    return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
