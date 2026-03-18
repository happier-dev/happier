import { execFile as execFileCallback } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { ScmSourceControllerWorkspaceTransferInput } from '../../../types';
import {
    createScmSourceControllerWorkspaceTransferEntry,
    type ScmSourceControllerWorkspaceTransferEntry,
} from '../../../sourceController/workspaceTransfer';
import { inspectGitCheckoutIdentity, isGitLinkedWorktreeIdentity } from '../checkoutIdentity';

const execFile = promisify(execFileCallback);

function normalizeRelativePath(value: string): string {
    return value.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
}

async function listGitManagedPaths(sourcePath: string): Promise<readonly string[]> {
    const { stdout } = await execFile('git', ['-C', sourcePath, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '.']);
    return stdout
        .split('\0')
        .map((entry) => normalizeRelativePath(entry))
        .filter(Boolean);
}

async function listSelectedIgnoredPaths(sourcePath: string, ignoredIncludeGlobs: readonly string[]): Promise<readonly string[]> {
    if (ignoredIncludeGlobs.length === 0) {
        return [];
    }

    const { stdout } = await execFile('git', [
        '-C',
        sourcePath,
        'ls-files',
        '-z',
        '--others',
        '-i',
        '--exclude-standard',
        '--',
        ...ignoredIncludeGlobs,
    ]);
    return stdout
        .split('\0')
        .map((entry) => normalizeRelativePath(entry))
        .filter(Boolean);
}

async function resolveGitDirectoryPath(sourcePath: string): Promise<string | null> {
    try {
        const { stdout } = await execFile('git', ['-C', sourcePath, 'rev-parse', '--path-format=absolute', '--git-dir']);
        const gitDirectoryPath = stdout.trim();
        return gitDirectoryPath.length > 0 ? gitDirectoryPath : null;
    } catch {
        const { stdout } = await execFile('git', ['-C', sourcePath, 'rev-parse', '--git-dir']);
        const gitDirectoryPath = stdout.trim();
        if (gitDirectoryPath.length === 0) {
            return null;
        }

        return isAbsolute(gitDirectoryPath) ? gitDirectoryPath : resolve(sourcePath, gitDirectoryPath);
    }
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
