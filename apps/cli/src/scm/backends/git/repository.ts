import type { ScmRepoDetection, ScmBackendContext } from '../../types';
import type { ScmStatusSnapshotResponse } from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { runScmCommand } from '../../runtime';
import { normalizeRepoRootRelativePath } from '../../runtime';
import { buildGitSnapshot } from './statusSnapshot';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const UNTRACKED_STATS_MAX_FILES = 512;
const UNTRACKED_STATS_MAX_BYTES = 5_000_000;

function countTextLines(buffer: Buffer): number {
    if (buffer.length === 0) return 0;
    let lines = 1;
    for (let i = 0; i < buffer.length; i += 1) {
        if (buffer[i] === 10) lines += 1;
    }
    return lines;
}

async function computeUntrackedStatsByPath(repoRoot: string): Promise<Record<string, { pendingAdded: number; isBinary: boolean }>> {
    const result = await runScmCommand({
        bin: 'git',
        cwd: repoRoot,
        args: ['ls-files', '--others', '--exclude-standard', '-z'],
        timeoutMs: 10_000,
    });
    if (!result.success || typeof result.stdout !== 'string') return {};

    const paths = result.stdout.split('\0').filter((p) => p.trim().length > 0).slice(0, UNTRACKED_STATS_MAX_FILES);
    const statsByPath: Record<string, { pendingAdded: number; isBinary: boolean }> = {};

    for (const rawPath of paths) {
        const normalized = normalizeRepoRootRelativePath(rawPath);
        if (!normalized.ok) continue;
        if (normalized.relativePath === '.' || normalized.relativePath.trim() === '') continue;

        const absPath = join(repoRoot, normalized.relativePath);
        try {
            const info = await stat(absPath);
            if (!info.isFile()) continue;
            if (info.size > UNTRACKED_STATS_MAX_BYTES) {
                statsByPath[normalized.relativePath] = { pendingAdded: 0, isBinary: true };
                continue;
            }

            const buf = await readFile(absPath);
            const isBinary = buf.includes(0);
            statsByPath[normalized.relativePath] = {
                pendingAdded: isBinary ? 0 : countTextLines(buf),
                isBinary,
            };
        } catch {
            // Ignore unreadable files (permissions/races).
        }
    }

    return statsByPath;
}

export async function detectGitRepo(input: { cwd: string }): Promise<ScmRepoDetection> {
    const gitRepoCheck = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: ['rev-parse', '--is-inside-work-tree'],
        timeoutMs: 5000,
    });
    if (!gitRepoCheck.success || gitRepoCheck.exitCode !== 0) {
        return {
            isRepo: false,
            rootPath: null,
            mode: null,
        };
    }

    const rootResult = await runScmCommand({
        bin: 'git',
        cwd: input.cwd,
        args: ['rev-parse', '--show-toplevel'],
        timeoutMs: 5000,
    });

    return {
        isRepo: true,
        rootPath: rootResult.success ? rootResult.stdout.trim() : null,
        mode: '.git',
    };
}

export async function getGitSnapshot(input: {
    context: ScmBackendContext;
}): Promise<ScmStatusSnapshotResponse> {
    const { context } = input;
    const repoRoot = context.detection.rootPath ?? context.cwd;

    const statusResult = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['status', '--porcelain=v2', '-z', '--branch', '--show-stash', '--untracked-files=all'],
        timeoutMs: 10_000,
    });
    if (!statusResult.success) {
        return {
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
            error: statusResult.stderr || 'Failed to read repository status',
        };
    }

    const includedResult = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['diff', '--cached', '--numstat', '-z'],
        timeoutMs: 10_000,
    });
    const pendingResult = await runScmCommand({
        bin: 'git',
        cwd: context.cwd,
        args: ['diff', '--numstat', '-z'],
        timeoutMs: 10_000,
    });

    const statusRaw = statusResult.stdout ?? '';
    const hasUntrackedHint = /(?:^|\0)\?\s/.test(statusRaw);
    const untrackedStatsByPath = repoRoot && hasUntrackedHint ? await computeUntrackedStatsByPath(repoRoot) : {};

    return {
        success: true,
        snapshot: buildGitSnapshot({
            projectKey: context.projectKey,
            fetchedAt: Date.now(),
            rootPath: context.detection.rootPath,
            statusOutput: statusResult.stdout ?? '',
            includedNumStatOutput: includedResult.success ? (includedResult.stdout ?? '') : '',
            pendingNumStatOutput: pendingResult.success ? (pendingResult.stdout ?? '') : '',
            untrackedStatsByPath,
        }),
    };
}
