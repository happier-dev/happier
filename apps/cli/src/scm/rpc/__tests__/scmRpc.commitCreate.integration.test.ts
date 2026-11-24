import { describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
    SCM_OPERATION_ERROR_CODES,
    ScmCommitCreateResponseSchema,
    type ScmCommitCreateRequest,
    type ScmCommitCreateResponse,
} from '@happier-dev/protocol';
import { createGitWorkspace, createTestGitRpcManager as createTestRpcManager, runGit as git } from './testRpcHarness';

describe('git RPC handlers', () => {
    it.each([
        { name: 'missing config', diagnostic: /Author identity unknown/i },
        { name: 'empty name', diagnostic: /empty ident name/i },
    ])('returns a typed commit refusal for $name', async ({ name, diagnostic }) => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'pending\n');
        git(workspace, ['config', 'user.useConfigOnly', 'true']);
        if (name === 'missing config') {
            git(workspace, ['config', '--unset', 'user.name']);
            git(workspace, ['config', '--unset', 'user.email']);
        } else {
            git(workspace, ['config', 'user.name', '']);
        }
        vi.stubEnv('GIT_CONFIG_GLOBAL', join(workspace, 'missing.gitconfig'));
        vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
        vi.stubEnv('GIT_AUTHOR_NAME', undefined);
        vi.stubEnv('GIT_AUTHOR_EMAIL', undefined);
        vi.stubEnv('GIT_COMMITTER_NAME', undefined);
        vi.stubEnv('GIT_COMMITTER_EMAIL', undefined);
        vi.stubEnv('LC_ALL', 'C');
        try {
            const { call } = createTestRpcManager({ workingDirectory: workspace });
            const response = ScmCommitCreateResponseSchema.parse(await call<unknown, ScmCommitCreateRequest>(
                RPC_METHODS.SCM_COMMIT_CREATE,
                { cwd: '.', message: 'pending', scope: { kind: 'paths', include: ['a.txt'] }, outcomeVersion: 1 },
            ));
            expect(response).toMatchObject({
                success: false,
                errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_IDENTITY_REQUIRED,
                outcome: { kind: 'failed', errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_IDENTITY_REQUIRED },
                publication: { state: 'not_published' },
            });
            expect(response.error).toMatch(diagnostic);
            expect(response.outcome?.message).toBeUndefined();
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('includes unstaged, pre-staged, and untracked changes in all-pending atomic commits', async () => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'base-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\n');
        git(workspace, ['add', 'a.txt', 'b.txt']);
        git(workspace, ['commit', '-m', 'base']);

        writeFileSync(join(workspace, 'a.txt'), 'base-a\nnext-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\nnext-b\n');
        writeFileSync(join(workspace, 'c.txt'), 'new-c\n');
        git(workspace, ['add', 'b.txt']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const commit = await call<any, { cwd?: string; message: string; scope: { kind: 'all-pending' } }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'all pending',
                scope: { kind: 'all-pending' },
            },
        );
        expect(commit.success).toBe(true);

        const committedPaths = git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])
            .split('\n')
            .map((path) => path.trim())
            .filter(Boolean)
            .sort();
        expect(committedPaths).toEqual(['a.txt', 'b.txt', 'c.txt']);
        expect(git(workspace, ['diff', '--name-only'])).toBe('');
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('');
    });

    it('refuses publication when the live-index lock is already owned by another actor', async () => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        const expectedHeadOid = git(workspace, ['rev-parse', 'HEAD']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nnext\n');
        writeFileSync(join(workspace, '.git', 'index.lock'), '');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<ScmCommitCreateResponse, ScmCommitCreateRequest>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'commit while lock exists',
                outcomeVersion: 1,
                scope: { kind: 'all-pending' },
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode, JSON.stringify(response)).toBe(SCM_OPERATION_ERROR_CODES.INDEX_LOCKED);
        expect(response.publication).toMatchObject({ state: 'not_published', expectedHeadOid });
        expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(expectedHeadOid);
    });

    it('preserves the explicit base through RPC and refuses a divergent HEAD before publication', async () => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']); git(workspace, ['commit', '-m', 'base']);
        const expectedHeadOid = git(workspace, ['rev-parse', 'HEAD']);
        const expectedRef = git(workspace, ['symbolic-ref', 'HEAD']);
        git(workspace, ['commit', '--allow-empty', '-m', 'another actor']);
        const actualHead = git(workspace, ['rev-parse', 'HEAD']);
        writeFileSync(join(workspace, 'a.txt'), 'selected\n');
        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<ScmCommitCreateResponse, ScmCommitCreateRequest>(RPC_METHODS.SCM_COMMIT_CREATE, {
            cwd: '.', message: 'selected', outcomeVersion: 1, expectedHeadOid, expectedRef, scope: { kind: 'paths', include: ['a.txt'] },
        });
        expect(response).toMatchObject({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_HEAD_CHANGED, publication: { state: 'not_published', expectedHeadOid, expectedRef } });
        expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(actualHead);
        expect(git(workspace, ['show', 'HEAD:a.txt'])).toBe('base');
    });

    it('rejects commit creation when message is missing', async () => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, any>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('creates path-scoped commit without consuming unrelated pre-staged changes', async () => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'base-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\n');
        git(workspace, ['add', 'a.txt', 'b.txt']);
        git(workspace, ['commit', '-m', 'base']);

        writeFileSync(join(workspace, 'a.txt'), 'next-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'next-b\n');
        git(workspace, ['add', 'b.txt']);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string; scope: { kind: 'paths'; include: string[] } }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'scoped',
                scope: {
                    kind: 'paths',
                    include: ['a.txt'],
                },
            },
        );

        expect(response.success).toBe(true);
        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('a.txt');
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('b.txt');
    });

    it('creates path-scoped root commit for an untracked file and synchronizes the live index', async () => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'root.txt'), 'root\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string; scope: { kind: 'paths'; include: string[] } }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'root path-scoped commit',
                scope: {
                    kind: 'paths',
                    include: ['root.txt'],
                },
            },
        );

        expect(response.success).toBe(true);
        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('root.txt');
        expect(git(workspace, ['status', '--porcelain=v2'])).toBe('');
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('');
    });

    it('creates patch-based commit without consuming unrelated pre-staged changes', async () => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\n');
        git(workspace, ['add', 'a.txt', 'b.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nline-one\nline-two\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\nnext-b\n');
        git(workspace, ['add', 'b.txt']);

        const patch = [
            'diff --git a/a.txt b/a.txt',
            'index df967b9..9f0e218 100644',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1,2 @@',
            ' base',
            '+line-one',
            '',
        ].join('\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string; patches: Array<{ path: string; patch: string }> }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'virtual line selection commit',
                patches: [{ path: 'a.txt', patch }],
            },
        );

        expect(response.success).toBe(true);
        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('a.txt');
        expect(git(workspace, ['show', '--pretty=', 'HEAD'])).toContain('line-one');
        expect(git(workspace, ['show', '--pretty=', 'HEAD'])).not.toContain('line-two');
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('b.txt');
        expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('base\nline-one\nline-two\n');
    });

    it('does not unstage pre-staged changes on the same path during patch-based atomic commits', async () => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);

        // Pre-stage a superset of changes on the same file.
        writeFileSync(join(workspace, 'a.txt'), 'base\nline-one\nline-two\n');
        git(workspace, ['add', 'a.txt']);

        const patch = [
            'diff --git a/a.txt b/a.txt',
            'index df967b9..9f0e218 100644',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1,2 @@',
            ' base',
            '+line-one',
            '',
        ].join('\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string; patches: Array<{ path: string; patch: string }> }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'partial commit preserves staged remainder',
                patches: [{ path: 'a.txt', patch }],
            },
        );

        expect(response.success, JSON.stringify(response)).toBe(true);
        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('a.txt');

        // The live index should keep the staged-but-uncommitted remainder.
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('a.txt');
        const cachedDiff = git(workspace, ['diff', '--cached']);
        expect(cachedDiff).toContain('+line-two');
        expect(cachedDiff).not.toContain('+line-one');
    });

    it('allows mixed path scope and patch selection by preferring patch selection for overlapping files', async () => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\n');
        git(workspace, ['add', 'a.txt', 'b.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nline-one\nline-two\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\nline-b\n');

        const patch = [
            'diff --git a/a.txt b/a.txt',
            'index df967b9..9f0e218 100644',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1,2 @@',
            ' base',
            '+line-one',
            '',
        ].join('\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, {
            cwd?: string;
            message: string;
            scope: { kind: 'paths'; include: string[] };
            patches: Array<{ path: string; patch: string }>;
        }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'mixed selection commit',
                scope: {
                    kind: 'paths',
                    include: ['a.txt', 'b.txt'],
                },
                patches: [{ path: 'a.txt', patch }],
            },
        );

        expect(response.success).toBe(true);
        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('a.txt\nb.txt');
        expect(git(workspace, ['show', '--pretty=', 'HEAD'])).toContain('+line-one');
        expect(git(workspace, ['show', '--pretty=', 'HEAD'])).not.toContain('+line-two');
        expect(git(workspace, ['show', '--pretty=', 'HEAD'])).toContain('+line-b');
        expect(git(workspace, ['diff', '--name-only'])).toBe('a.txt');
    });

    it('rejects patch-based commit when declared path does not match patch header paths', async () => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nline-one\n');

        const patch = [
            'diff --git a/a.txt b/a.txt',
            'index df967b9..9f0e218 100644',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1,2 @@',
            ' base',
            '+line-one',
            '',
        ].join('\n');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string; patches: Array<{ path: string; patch: string }> }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'invalid path binding',
                patches: [{ path: 'b.txt', patch }],
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('returns a deterministic pre-check error when included-change inspection fails', async () => {
        const workspace = createGitWorkspace();
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'next\n');
        git(workspace, ['add', 'a.txt']);

        // Corrupt index to force git diff --cached --quiet to fail deterministically.
        const head = git(workspace, ['rev-parse', 'HEAD']);
        writeFileSync(join(workspace, '.git', 'index'), 'not-a-valid-index');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const response = await call<any, { cwd?: string; message: string }>(
            RPC_METHODS.SCM_COMMIT_CREATE,
            {
                cwd: '.',
                message: 'commit after corruption',
            },
        );

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.COMMAND_FAILED);
        expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(head);
        expect(readFileSync(join(workspace, '.git', 'index'), 'utf8')).toBe('not-a-valid-index');
    });
});
