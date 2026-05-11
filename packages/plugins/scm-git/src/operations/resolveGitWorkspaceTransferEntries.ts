import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import type { ScmWorkspaceIntegrationWorkspaceTransferInput } from '../types.js';
import {
    createScmWorkspaceIntegrationWorkspaceTransferEntry,
    type ScmWorkspaceIntegrationWorkspaceTransferEntry,
} from '../workspace/workspaceTransfer.js';
import { runScmCommand } from '../runtime.js';
import { inspectGitCheckoutIdentity, isGitLinkedWorktreeIdentity } from '../checkoutIdentity.js';

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
    const result = await runScmCommand({
        bin: 'git',
        cwd: params.cwd,
        args: [...params.args],
        maxOutputBytes: maxStdoutBytes,
    });
    if (!result.success) {
        throw new Error((result.stderr || `git exited with code ${result.exitCode}`).trim());
    }

    return result.stdout
        .split('\0')
        .map(normalizeRelativePath)
        .filter((entry) => entry.length > 0);
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

async function listGitMetadataEntries(sourcePath: string): Promise<readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[]> {
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
        .map(createScmWorkspaceIntegrationWorkspaceTransferEntry);
}

async function resolveCanonicalComparisonPath(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch {
        return resolve(path);
    }
}

async function shouldIncludeGitMetadataEntries(input: ScmWorkspaceIntegrationWorkspaceTransferInput): Promise<boolean> {
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

export async function resolveGitWorkspaceTransferEntries(input: ScmWorkspaceIntegrationWorkspaceTransferInput): Promise<readonly ScmWorkspaceIntegrationWorkspaceTransferEntry[]> {
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
            .map((relativePath) => createScmWorkspaceIntegrationWorkspaceTransferEntry({
                relativePath,
                sourcePath: join(sourcePath, relativePath),
            })),
        ...(await shouldIncludeGitMetadataEntries(input) ? await listGitMetadataEntries(sourcePath) : []),
    ];

    return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}
