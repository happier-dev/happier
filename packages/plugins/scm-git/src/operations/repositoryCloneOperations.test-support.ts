import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  createScmCapabilities,
  type ScmRepositoryCloneInput,
  type ScmRepositoryCloneOutput,
  type ScmWorkingSnapshot,
  type ScmRepositoryCloneTargetDescription,
} from '@happier-dev/plugin-sdk/scm';
import { expect } from 'vitest';

import { runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
import type { ScmBackendContext } from '../types.js';
import { createGitRepositoryCloneOperation } from './repositoryCloneOperations.js';

export type RepositoryCloneOperation = (input: {
    context: ScmBackendContext;
    request: ScmRepositoryCloneInput;
}) => Promise<ScmRepositoryCloneOutput>;

export function runGit(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

export function cloneWithRealGitRuntime(
    repositoryClone: RepositoryCloneOperation,
    input: Parameters<RepositoryCloneOperation>[0],
    options?: Parameters<typeof runWithRealGitScmRuntime>[1],
) {
    return runWithRealGitScmRuntime(() => repositoryClone(input), options);
}

export function createWorkspace(): string {
    return mkdtempSync(join(tmpdir(), 'happier-git-clone-operation-'));
}

export function readSnapshotFromGit(context: ScmBackendContext): ScmWorkingSnapshot {
    return {
        projectKey: context.projectKey,
        fetchedAt: Date.now(),
        repo: {
            isRepo: true,
            backendId: 'git',
            mode: '.git',
            rootPath: runGit(context.cwd, ['rev-parse', '--show-toplevel']),
            remotes: [],
            worktrees: [],
        },
        capabilities: createScmCapabilities(),
        branch: {
            head: runGit(context.cwd, ['branch', '--show-current']) || null,
            upstream: null,
            ahead: 0,
            behind: 0,
            detached: false,
        },
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

export function createInMemorySnapshot(context: ScmBackendContext): ScmWorkingSnapshot {
    return {
        projectKey: context.projectKey,
        fetchedAt: Date.now(),
        repo: {
            isRepo: true,
            backendId: 'git',
            mode: '.git',
            rootPath: context.cwd,
            remotes: [],
            worktrees: [],
        },
        capabilities: createScmCapabilities(),
        branch: {
            head: 'main',
            upstream: null,
            ahead: 0,
            behind: 0,
            detached: false,
        },
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

export function getRepositoryCloneOperation(
    deps?: Parameters<typeof createGitRepositoryCloneOperation>[0],
): RepositoryCloneOperation {
    const operation = createGitRepositoryCloneOperation({
        ...deps,
        readSnapshot: deps?.readSnapshot ?? (async ({ context }) => readSnapshotFromGit(context)),
    });
    expect(operation.clone).toBeTypeOf('function');
    return operation.clone;
}

export function makeContext(cwd: string): ScmBackendContext {
    return {
        cwd,
        projectKey: `test:${cwd}`,
        detection: { isRepo: false, rootPath: null, mode: null },
    };
}

export function createBareRemoteRepository(): string {
    const root = createWorkspace();
    const source = join(root, 'source');
    const bare = join(root, 'remote.git');
    mkdirSync(source, { recursive: true });
    runGit(source, ['init', '-b', 'main']);
    runGit(source, ['config', 'user.email', 'test@example.com']);
    runGit(source, ['config', 'user.name', 'Test User']);
    writeFileSync(join(source, 'README.md'), 'hello\n');
    runGit(source, ['add', 'README.md']);
    runGit(source, ['commit', '-m', 'initial']);
    runGit(root, ['clone', '--bare', source, bare]);
    return bare;
}

export function makeRequest(parent: string, remotePath: string, destinationDirectoryName = 'happier'): ScmRepositoryCloneInput {
    return {
        provider: {
            id: 'github:github.com',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
            urlSafety: { allowedSchemes: ['https:', 'file:'] },
        },
        repository: {
            nameWithOwner: 'happier-dev/happier',
            webUrl: 'https://github.com/happier-dev/happier',
            cloneUrl: `file://${remotePath}`,
            visibility: 'public',
            defaultBranch: 'main',
        },
        destinationParentPath: parent,
        destinationDirectoryName,
        protocol: 'https',
        confirmed: true,
        authorizationToken: 'clone-repository',
    };
}

export function makeProviderRegistry(description: ScmRepositoryCloneTargetDescription) {
    return {
        getProvider: () => description.repository.provider,
        getAdapter: () => ({
            describeCloneTargets: async () => description,
        }),
    };
}

export function makeCloneTargetDescription(remotePath: string): ScmRepositoryCloneTargetDescription {
    return {
        auth: { state: 'authenticated', profileKind: 'provider_cli' },
        repository: {
            provider: {
                id: 'github:github.com',
                kind: 'github',
                displayName: 'GitHub',
                baseUrl: 'https://github.com',
                urlSafety: { allowedSchemes: ['https:', 'file:'] },
            },
            nameWithOwner: 'happier-dev/happier',
            webUrl: 'https://github.com/happier-dev/happier',
            cloneUrl: `file://${remotePath}`,
            visibility: 'public',
            defaultBranch: 'main',
        },
        targets: [
            {
                protocol: 'https',
                url: `file://${remotePath}`,
                isDefault: true,
            },
        ],
    };
}
