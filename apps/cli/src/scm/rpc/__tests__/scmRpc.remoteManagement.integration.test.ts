import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import type {
    ScmRemoteAddRequest,
    ScmRemoteManagementResponse,
    ScmRemoteRemoveRequest,
    ScmRemoteSetUrlRequest,
    ScmStatusSnapshotRequest,
    ScmStatusSnapshotResponse,
} from '@happier-dev/protocol';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it } from 'vitest';

import { createTestRpcManager, runGit as git } from './testRpcHarness';

function initWorkspace(): string {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-git-remotes-rpc-'));
    git(workspace, ['init']);
    git(workspace, ['config', 'user.email', 'test@example.com']);
    git(workspace, ['config', 'user.name', 'Test User']);
    return workspace;
}

function initBareRemote(prefix: string): string {
    const remote = mkdtempSync(join(tmpdir(), prefix));
    git(remote, ['init', '--bare']);
    return remote;
}

function withGitWrapper<T>(options: {
    onPushSetUrlFailure?: string;
    onUnsetPushUrlFailure?: string;
    run: () => Promise<T>;
}): Promise<T> {
    const wrapperDir = mkdtempSync(join(tmpdir(), 'happier-git-wrapper-'));
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const wrapperPath = join(wrapperDir, 'git');
    writeFileSync(
        wrapperPath,
        `#!/bin/sh
if [ "$1" = "remote" ] && [ "$2" = "set-url" ] && [ "$3" = "--push" ]; then
    printf '%s\\n' '${(options.onPushSetUrlFailure ?? 'simulated set-url --push failure').replace(/'/g, `'\"'\"'`)}' >&2
    exit 1
fi
if [ "$1" = "config" ] && [ "$2" = "--unset-all" ] && [ "$3" = "remote.origin.pushurl" ]; then
    printf '%s\\n' '${(options.onUnsetPushUrlFailure ?? 'simulated unset pushurl failure').replace(/'/g, `'\"'\"'`)}' >&2
    exit 1
fi
exec "${realGit}" "$@"
`,
        'utf8',
    );
    chmodSync(wrapperPath, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${wrapperDir}:${originalPath ?? ''}`;

    return options.run().finally(() => {
        process.env.PATH = originalPath;
    });
}

describe('git RPC handlers (remote management)', () => {
    it('adds a remote using a local path and reports it in status snapshots', async () => {
        const workspace = initWorkspace();
        const remote = initBareRemote('happier-git-remote-add-');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const add = await call<ScmRemoteManagementResponse, ScmRemoteAddRequest>(
            RPC_METHODS.SCM_REMOTE_ADD,
            {
                cwd: '.',
                name: ' origin ',
                fetchUrl: remote,
            },
        );

        expect(add.success).toBe(true);

        const status = await call<ScmStatusSnapshotResponse, ScmStatusSnapshotRequest>(
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            { cwd: '.' },
        );
        expect(status.success).toBe(true);
        expect(status.snapshot?.repo.remotes).toEqual([
            {
                name: 'origin',
                fetchUrl: remote,
                pushUrl: remote,
            },
        ]);
    });

    it('rejects duplicate remote names', async () => {
        const workspace = initWorkspace();
        const remote = initBareRemote('happier-git-remote-duplicate-');
        git(workspace, ['remote', 'add', 'origin', remote]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const add = await call<ScmRemoteManagementResponse, ScmRemoteAddRequest>(
            RPC_METHODS.SCM_REMOTE_ADD,
            {
                cwd: '.',
                name: 'origin',
                fetchUrl: remote,
            },
        );

        expect(add).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_ALREADY_EXISTS,
        });
    });

    it('removes the newly added remote when push-url configuration fails during add', async () => {
        const workspace = initWorkspace();
        const fetchRemote = initBareRemote('happier-git-remote-rollback-fetch-');
        const pushRemote = initBareRemote('happier-git-remote-rollback-push-');

        await withGitWrapper({
            onPushSetUrlFailure: 'simulated set-url --push failure',
            run: async () => {
                const { call } = createTestRpcManager({ workingDirectory: workspace });
                const add = await call<ScmRemoteManagementResponse, ScmRemoteAddRequest>(
                    RPC_METHODS.SCM_REMOTE_ADD,
                    {
                        cwd: '.',
                        name: 'origin',
                        fetchUrl: fetchRemote,
                        pushUrl: pushRemote,
                    },
                );

                expect(add).toMatchObject({
                    success: false,
                });
                expect(add.error).toContain('simulated set-url --push failure');
            },
        });

        const status = await createTestRpcManager({ workingDirectory: workspace }).call<
            ScmStatusSnapshotResponse,
            ScmStatusSnapshotRequest
        >(
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            { cwd: '.' },
        );
        expect(status.success).toBe(true);
        expect(status.snapshot?.repo.remotes).toEqual([]);
        expect(git(workspace, ['remote'])).toBe('');
    });

    it('sets fetch and push URLs independently', async () => {
        const workspace = initWorkspace();
        const originalRemote = initBareRemote('happier-git-remote-original-');
        const fetchRemote = initBareRemote('happier-git-remote-fetch-');
        const pushRemote = initBareRemote('happier-git-remote-push-');
        git(workspace, ['remote', 'add', 'origin', originalRemote]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const setUrl = await call<ScmRemoteManagementResponse, ScmRemoteSetUrlRequest>(
            RPC_METHODS.SCM_REMOTE_SET_URL,
            {
                cwd: '.',
                name: 'origin',
                fetchUrl: fetchRemote,
                pushUrl: pushRemote,
            },
        );

        expect(setUrl.success).toBe(true);

        const status = await call<ScmStatusSnapshotResponse, ScmStatusSnapshotRequest>(
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            { cwd: '.' },
        );
        expect(status.snapshot?.repo.remotes).toEqual([
            {
                name: 'origin',
                fetchUrl: fetchRemote,
                pushUrl: pushRemote,
            },
        ]);
    });

    it('supports slash-delimited remote names across add, set-url, and remove', async () => {
        const workspace = initWorkspace();
        const originalRemote = initBareRemote('happier-git-remote-slash-original-');
        const fetchRemote = initBareRemote('happier-git-remote-slash-fetch-');
        const pushRemote = initBareRemote('happier-git-remote-slash-push-');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const add = await call<ScmRemoteManagementResponse, ScmRemoteAddRequest>(
            RPC_METHODS.SCM_REMOTE_ADD,
            {
                cwd: '.',
                name: ' fork/alice ',
                fetchUrl: originalRemote,
            },
        );

        expect(add.success).toBe(true);

        const setUrl = await call<ScmRemoteManagementResponse, ScmRemoteSetUrlRequest>(
            RPC_METHODS.SCM_REMOTE_SET_URL,
            {
                cwd: '.',
                name: 'fork/alice',
                fetchUrl: fetchRemote,
                pushUrl: pushRemote,
            },
        );

        expect(setUrl.success).toBe(true);

        const statusAfterSetUrl = await call<ScmStatusSnapshotResponse, ScmStatusSnapshotRequest>(
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            { cwd: '.' },
        );
        expect(statusAfterSetUrl.snapshot?.repo.remotes).toEqual([
            {
                name: 'fork/alice',
                fetchUrl: fetchRemote,
                pushUrl: pushRemote,
            },
        ]);

        const remove = await call<ScmRemoteManagementResponse, ScmRemoteRemoveRequest>(
            RPC_METHODS.SCM_REMOTE_REMOVE,
            {
                cwd: '.',
                name: 'fork/alice',
            },
        );

        expect(remove.success).toBe(true);

        const statusAfterRemove = await call<ScmStatusSnapshotResponse, ScmStatusSnapshotRequest>(
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            { cwd: '.' },
        );
        expect(statusAfterRemove.snapshot?.repo.remotes).toEqual([]);
    });

    it('clears an explicit push URL so push falls back to fetch URL', async () => {
        const workspace = initWorkspace();
        const fetchRemote = initBareRemote('happier-git-remote-clear-fetch-');
        const pushRemote = initBareRemote('happier-git-remote-clear-push-');
        git(workspace, ['remote', 'add', 'origin', fetchRemote]);
        git(workspace, ['remote', 'set-url', '--push', 'origin', pushRemote]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const setUrl = await call<ScmRemoteManagementResponse, ScmRemoteSetUrlRequest>(
            RPC_METHODS.SCM_REMOTE_SET_URL,
            {
                cwd: '.',
                name: 'origin',
                pushUrl: null,
            },
        );

        expect(setUrl.success).toBe(true);

        const status = await call<ScmStatusSnapshotResponse, ScmStatusSnapshotRequest>(
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            { cwd: '.' },
        );
        expect(status.snapshot?.repo.remotes).toEqual([
            {
                name: 'origin',
                fetchUrl: fetchRemote,
                pushUrl: fetchRemote,
            },
        ]);
    });

    it('rolls back fetch and push URLs when setting push URL fails after fetch URL changed', async () => {
        const workspace = initWorkspace();
        const originalFetchRemote = initBareRemote('happier-git-remote-rollback-original-fetch-');
        const originalPushRemote = initBareRemote('happier-git-remote-rollback-original-push-');
        const nextFetchRemote = initBareRemote('happier-git-remote-rollback-next-fetch-');
        const nextPushRemote = initBareRemote('happier-git-remote-rollback-next-push-');
        git(workspace, ['remote', 'add', 'origin', originalFetchRemote]);
        git(workspace, ['remote', 'set-url', '--push', 'origin', originalPushRemote]);

        await withGitWrapper({
            onPushSetUrlFailure: 'simulated set-url --push failure',
            run: async () => {
                const { call } = createTestRpcManager({ workingDirectory: workspace });
                const setUrl = await call<ScmRemoteManagementResponse, ScmRemoteSetUrlRequest>(
                    RPC_METHODS.SCM_REMOTE_SET_URL,
                    {
                        cwd: '.',
                        name: 'origin',
                        fetchUrl: nextFetchRemote,
                        pushUrl: nextPushRemote,
                    },
                );

                expect(setUrl).toMatchObject({
                    success: false,
                });
                expect(setUrl.error).toContain('simulated set-url --push failure');
            },
        });

        const status = await createTestRpcManager({ workingDirectory: workspace }).call<
            ScmStatusSnapshotResponse,
            ScmStatusSnapshotRequest
        >(
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            { cwd: '.' },
        );
        expect(status.success).toBe(true);
        expect(status.snapshot?.repo.remotes).toEqual([
            {
                name: 'origin',
                fetchUrl: originalFetchRemote,
                pushUrl: originalPushRemote,
            },
        ]);
    });

    it('rolls back fetch and push URLs when clearing push URL fails after fetch URL changed', async () => {
        const workspace = initWorkspace();
        const originalFetchRemote = initBareRemote('happier-git-remote-clear-rollback-original-fetch-');
        const originalPushRemote = initBareRemote('happier-git-remote-clear-rollback-original-push-');
        const nextFetchRemote = initBareRemote('happier-git-remote-clear-rollback-next-fetch-');
        git(workspace, ['remote', 'add', 'origin', originalFetchRemote]);
        git(workspace, ['remote', 'set-url', '--push', 'origin', originalPushRemote]);

        await withGitWrapper({
            onUnsetPushUrlFailure: 'simulated unset pushurl failure',
            run: async () => {
                const { call } = createTestRpcManager({ workingDirectory: workspace });
                const setUrl = await call<ScmRemoteManagementResponse, ScmRemoteSetUrlRequest>(
                    RPC_METHODS.SCM_REMOTE_SET_URL,
                    {
                        cwd: '.',
                        name: 'origin',
                        fetchUrl: nextFetchRemote,
                        pushUrl: null,
                    },
                );

                expect(setUrl).toMatchObject({
                    success: false,
                });
                expect(setUrl.error).toContain('simulated unset pushurl failure');
            },
        });

        const status = await createTestRpcManager({ workingDirectory: workspace }).call<
            ScmStatusSnapshotResponse,
            ScmStatusSnapshotRequest
        >(
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            { cwd: '.' },
        );
        expect(status.success).toBe(true);
        expect(status.snapshot?.repo.remotes).toEqual([
            {
                name: 'origin',
                fetchUrl: originalFetchRemote,
                pushUrl: originalPushRemote,
            },
        ]);
    });

    it('removes a remote', async () => {
        const workspace = initWorkspace();
        const remote = initBareRemote('happier-git-remote-remove-');
        git(workspace, ['remote', 'add', 'origin', remote]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const remove = await call<ScmRemoteManagementResponse, ScmRemoteRemoveRequest>(
            RPC_METHODS.SCM_REMOTE_REMOVE,
            {
                cwd: '.',
                name: 'origin',
            },
        );

        expect(remove.success).toBe(true);

        const status = await call<ScmStatusSnapshotResponse, ScmStatusSnapshotRequest>(
            RPC_METHODS.SCM_STATUS_SNAPSHOT,
            { cwd: '.' },
        );
        expect(status.snapshot?.repo.remotes).toEqual([]);
    });

    it('returns remote-not-found when removing a missing remote', async () => {
        const workspace = initWorkspace();

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const remove = await call<ScmRemoteManagementResponse, ScmRemoteRemoveRequest>(
            RPC_METHODS.SCM_REMOTE_REMOVE,
            {
                cwd: '.',
                name: 'origin',
            },
        );

        expect(remove).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND,
        });
    });

    it('rejects unsafe remote management values before git sees them', async () => {
        const workspace = initWorkspace();

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const add = await call<ScmRemoteManagementResponse, ScmRemoteAddRequest>(
            RPC_METHODS.SCM_REMOTE_ADD,
            {
                cwd: '.',
                name: '--upload-pack=hack',
                fetchUrl: '--upload-pack=hack',
            },
        );

        expect(add).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(git(workspace, ['remote'])).toBe('');
    });
});
