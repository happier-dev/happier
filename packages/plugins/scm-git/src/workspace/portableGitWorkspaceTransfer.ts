import { isAbsolute, join, relative, sep } from 'node:path';

import {
    createScmWorkspaceIntegrationWorkspaceTransferEntry,
    createScmWorkspaceIntegrationWorkspaceTransferResult,
} from '../workspace/workspaceTransfer.js';
import type {
    ScmWorkspaceIntegrationWorkspaceTransferInput,
    ScmWorkspaceIntegrationWorkspaceTransferResult,
} from '../types.js';
import { getScmCommandIndeterminateErrorCode, runScmCommand } from '../runtime.js';
import { readRepositoryFileSystem } from '../repositoryFileSystem.js';
import { buildScmNonInteractiveEnv } from '../providers/shared/nonInteractiveEnv.js';
import { resolveGitWorkspaceTransferSelection } from '../operations/resolveGitWorkspaceTransferEntries.js';
import {
    isGitWorkspaceTransferMetadata,
    resolveGitWorkspaceTransferMetadata,
} from '../workspaceTransferMetadata.js';

const PORTABLE_BUNDLE_RELATIVE_PATH = '.happier-scm/git.bundle' as const;

function selectionUnavailable(message: string): Error {
    return Object.assign(new Error(message), { code: 'git_selection_unavailable' });
}

export async function resolvePortableGitWorkspaceRoot(input: Readonly<{
    cwd: string;
    repositoryRoot: string;
}>): Promise<Readonly<{ repositoryRoot: string; sessionRelativeCwd: string }>> {
    const { realpath } = readRepositoryFileSystem();
    const [repositoryRoot, sessionCwd] = await Promise.all([
        realpath(input.repositoryRoot).catch(() => null),
        realpath(input.cwd).catch(() => null),
    ]);
    if (!repositoryRoot || !sessionCwd) {
        throw selectionUnavailable('Git workspace root or session directory is unavailable');
    }
    const relativeCwd = relative(repositoryRoot, sessionCwd);
    if (isAbsolute(relativeCwd) || relativeCwd === '..' || relativeCwd.startsWith(`..${sep}`)) {
        throw selectionUnavailable('Git session directory escapes the selected worktree root');
    }
    return {
        repositoryRoot,
        sessionRelativeCwd: relativeCwd.split(sep).join('/'),
    };
}

async function runGitOrThrow(cwd: string, args: readonly string[]): Promise<string> {
    const result = await runScmCommand({
        bin: 'git',
        cwd,
        args: [...args],
        timeoutMs: 60_000,
        env: buildScmNonInteractiveEnv(),
    });
    if (!result.success) {
        throw selectionUnavailable((result.stderr || result.stdout || 'Git command failed').trim());
    }
    return result.stdout;
}

async function readPortableBundleHeadRevision(input: Readonly<{
    repositoryRoot: string;
    bundlePath: string;
}>): Promise<string> {
    const output = await runGitOrThrow(input.repositoryRoot, [
        'bundle',
        'list-heads',
        input.bundlePath,
        'HEAD',
    ]);
    const advertisedHeads = output
        .trim()
        .split(/\r?\n/u)
        .map((line) => /^([0-9a-f]{40})\s+HEAD$/iu.exec(line.trim()))
        .filter((match): match is RegExpExecArray => match !== null);
    if (advertisedHeads.length !== 1) {
        throw selectionUnavailable('Portable Git bundle does not advertise exactly one usable HEAD revision');
    }
    return advertisedHeads[0]![1]!.toLowerCase();
}

export async function preparePortableGitWorkspaceTransfer(
    input: ScmWorkspaceIntegrationWorkspaceTransferInput & Readonly<{ artifactDirectory: string }>,
): Promise<ScmWorkspaceIntegrationWorkspaceTransferResult> {
    const { mkdir, mkdtemp, rm } = readRepositoryFileSystem();
    const detectedRepositoryRoot = input.context.detection.rootPath;
    if (!input.context.detection.isRepo || !detectedRepositoryRoot) {
        throw selectionUnavailable('Git workspace transfer requires a detected worktree root');
    }
    const { repositoryRoot, sessionRelativeCwd } = await resolvePortableGitWorkspaceRoot({
        cwd: input.context.cwd,
        repositoryRoot: detectedRepositoryRoot,
    });
    const repositoryInput = {
        ...input,
        context: {
            ...input.context,
            cwd: repositoryRoot,
            detection: { ...input.context.detection, rootPath: repositoryRoot },
        },
    };

    const metadata = await resolveGitWorkspaceTransferMetadata(repositoryInput);
    if (metadata?.checkoutKind === 'branch' && !metadata.headRevision) {
        const branch = await runScmCommand({ bin: 'git', cwd: repositoryRoot,
            args: ['show-ref', '--verify', '--quiet', `refs/heads/${metadata.branchName}`],
            env: buildScmNonInteractiveEnv() });
        // Only a completed absent-ref result proves an unborn branch; damaged
        // objects and unavailable commands must retain the normal bundle refusal.
        if (!branch.success && branch.exitCode === 1 && !getScmCommandIndeterminateErrorCode(branch)) {
            return createScmWorkspaceIntegrationWorkspaceTransferResult({
                ...await resolveGitWorkspaceTransferSelection(repositoryInput),
                metadata: { ...metadata, sessionRelativeCwd },
            });
        }
    }

    await mkdir(input.artifactDirectory, { recursive: true });
    const bundleDirectory = await mkdtemp(join(input.artifactDirectory, 'git-workspace-bundle-'));
    const bundlePath = join(bundleDirectory, 'git.bundle');
    try {
        await runGitOrThrow(repositoryRoot, [
            'bundle',
            'create',
            bundlePath,
            'HEAD',
        ]);
        const bundledHeadRevision = await readPortableBundleHeadRevision({
            repositoryRoot,
            bundlePath,
        });
        const selection = await resolveGitWorkspaceTransferSelection(repositoryInput);
        const { entries, excludedPaths } = selection;
        if (!metadata) {
            throw selectionUnavailable('Git workspace has no portable checkout metadata');
        }
        if (entries.some((entry) => (
            entry.relativePath === '.happier-scm'
            || entry.relativePath.startsWith('.happier-scm/')
        ))) {
            throw selectionUnavailable('Git workspace collides with the portable SCM artifact path');
        }

        return createScmWorkspaceIntegrationWorkspaceTransferResult({
            excludedPaths,
            entries: [
                ...entries,
                createScmWorkspaceIntegrationWorkspaceTransferEntry({
                    relativePath: PORTABLE_BUNDLE_RELATIVE_PATH,
                    sourcePath: bundlePath,
                    disposeSource: async () => await rm(bundleDirectory, { recursive: true, force: true }),
                }),
            ],
            metadata: {
                ...metadata,
                headRevision: bundledHeadRevision,
                sessionRelativeCwd,
                portableBundle: { v: 1, relativePath: PORTABLE_BUNDLE_RELATIVE_PATH },
            },
        });
    } catch (error) {
        await rm(bundleDirectory, { recursive: true, force: true });
        throw error;
    }
}

export async function materializePortableGitWorkspaceBundle(input: Readonly<{
    targetPath: string;
    workspaceIntegrationMetadata?: Readonly<Record<string, unknown>>;
}>): Promise<void> {
    const { rm } = readRepositoryFileSystem();
    const metadata = isGitWorkspaceTransferMetadata(input.workspaceIntegrationMetadata)
        ? input.workspaceIntegrationMetadata
        : null;
    if (!metadata) return;
    if (!metadata.portableBundle) {
        if (metadata.checkoutKind === 'branch' && !metadata.headRevision) {
            await runGitOrThrow(input.targetPath, ['init', '--quiet']);
            await runGitOrThrow(input.targetPath, ['symbolic-ref', 'HEAD', `refs/heads/${metadata.branchName}`]);
        }
        return;
    }
    const headRevision = metadata.headRevision;
    if (!headRevision) {
        throw selectionUnavailable('Portable Git bundle metadata has no HEAD revision');
    }

    const bundlePath = join(input.targetPath, metadata.portableBundle.relativePath);
    try {
        await runGitOrThrow(input.targetPath, ['init', '--quiet']);
        await runGitOrThrow(input.targetPath, [
            'fetch',
            '--no-tags',
            '--no-write-fetch-head',
            '--quiet',
            bundlePath,
            'HEAD',
        ]);
        if (metadata.checkoutKind === 'branch') {
            await runGitOrThrow(input.targetPath, [
                'update-ref',
                `refs/heads/${metadata.branchName}`,
                headRevision,
            ]);
            await runGitOrThrow(input.targetPath, [
                'symbolic-ref',
                'HEAD',
                `refs/heads/${metadata.branchName}`,
            ]);
        } else {
            await runGitOrThrow(input.targetPath, [
                'update-ref',
                '--no-deref',
                'HEAD',
                headRevision,
            ]);
        }
        await runGitOrThrow(input.targetPath, ['reset', '--mixed', '--quiet', 'HEAD']);
    } finally {
        await rm(join(input.targetPath, '.happier-scm'), { recursive: true, force: true });
    }
}
