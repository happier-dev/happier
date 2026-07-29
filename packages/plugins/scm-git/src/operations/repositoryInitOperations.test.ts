import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SCM_OPERATION_ERROR_CODES,
  type ScmRepositoryInitRequest,
  type ScmRepositoryInitResponse,
} from '@happier-dev/plugin-sdk/experimental/scm';
import { describe, expect, it } from 'vitest';

import { createGitBackend } from '../backend.js';
import { runWithRealGitScmRuntime } from '../testkit/scmRuntime.test-support.js';
import type { ScmBackend, ScmBackendContext } from '../types.js';

type RepositoryInitOperation = (input: {
    context: ScmBackendContext;
    request: ScmRepositoryInitRequest;
}) => Promise<ScmRepositoryInitResponse>;

function runGit(cwd: string, args: string[]): string {
    return execFileSync('git', args, {
        cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
}

function initWithRealGitRuntime(
    repositoryInit: RepositoryInitOperation,
    input: Parameters<RepositoryInitOperation>[0],
) {
    return runWithRealGitScmRuntime(() => repositoryInit(input));
}

function createWorkspace(): string {
    return mkdtempSync(join(tmpdir(), 'happier-git-init-operation-'));
}

function getRepositoryInitOperation(): RepositoryInitOperation {
    const backend = createGitBackend() as ScmBackend & {
        repositoryInit?: RepositoryInitOperation;
    };
    expect(backend.repositoryInit).toBeTypeOf('function');
    if (!backend.repositoryInit) {
        throw new Error('Git backend repositoryInit operation is not registered');
    }
    return backend.repositoryInit;
}

function makeContext(cwd: string, isRepo: boolean): ScmBackendContext {
    return {
        cwd,
        projectKey: `test:${cwd}`,
        detection: isRepo
            ? { isRepo: true, rootPath: realpathSync(cwd), mode: '.git' }
            : { isRepo: false, rootPath: null, mode: null },
    };
}

describe('git repository init operation', () => {
    it('initializes a non-repository once and returns a fresh snapshot', async () => {
        const workspace = createWorkspace();
        const repositoryInit = getRepositoryInitOperation();

        const response = await initWithRealGitRuntime(repositoryInit, {
            context: makeContext(workspace, false),
            request: { cwd: workspace, initialBranch: 'main' },
        });

        expect(response.success).toBe(true);
        if (!response.success) {
            throw new Error(response.error);
        }
        expect(response.alreadyInitialized).toBe(false);
        expect(runGit(workspace, ['rev-parse', '--is-inside-work-tree'])).toBe('true');
        expect(response.snapshot?.repo).toMatchObject({
            isRepo: true,
            backendId: 'git',
            mode: '.git',
        });
        expect(response.snapshot?.capabilities.writeRepositoryInit).toBe(true);
        expect(response.snapshot?.repo.rootPath).toBe(runGit(workspace, ['rev-parse', '--show-toplevel']));
    });

    it('returns alreadyInitialized without changing HEAD when the directory is already a repo', async () => {
        const workspace = createWorkspace();
        runGit(workspace, ['init']);
        runGit(workspace, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
        const headBefore = readFileSync(join(workspace, '.git', 'HEAD'), 'utf8');
        const repositoryInit = getRepositoryInitOperation();

        const response = await initWithRealGitRuntime(repositoryInit, {
            context: makeContext(workspace, true),
            request: { cwd: workspace, initialBranch: 'feature-after-existing' },
        });

        expect(response.success).toBe(true);
        if (!response.success) {
            throw new Error(response.error);
        }
        expect(response.alreadyInitialized).toBe(true);
        expect(readFileSync(join(workspace, '.git', 'HEAD'), 'utf8')).toBe(headBefore);
        expect(response.snapshot?.repo.isRepo).toBe(true);
    });

    it('rejects invalid initial branches before creating a .git directory', async () => {
        const workspace = createWorkspace();
        const repositoryInit = getRepositoryInitOperation();

        const response = await initWithRealGitRuntime(repositoryInit, {
            context: makeContext(workspace, false),
            request: { cwd: workspace, initialBranch: 'bad..branch' },
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(existsSync(join(workspace, '.git'))).toBe(false);
    });
});
