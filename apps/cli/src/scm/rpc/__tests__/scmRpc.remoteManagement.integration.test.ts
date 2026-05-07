import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { createTestRpcManager, runGit as git } from './testRpcHarness';

const SCM_REMOTE_ADD = 'scm.remote.add';
const SCM_REMOTE_SET_URL = 'scm.remote.setUrl';
const SCM_REMOTE_REMOVE = 'scm.remote.remove';
const SCM_STATUS_SNAPSHOT = 'scm.status.snapshot';
const REMOTE_ALREADY_EXISTS = 'REMOTE_ALREADY_EXISTS';

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

describe('git RPC handlers (remote management)', () => {
    it('adds a remote using a local path and reports it in status snapshots', async () => {
        const workspace = initWorkspace();
        const remote = initBareRemote('happier git remote add ');

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const add = await call<any, { cwd?: string; name: string; fetchUrl: string }>(SCM_REMOTE_ADD, {
            cwd: '.',
            name: ' origin ',
            fetchUrl: remote,
        });

        expect(add.success).toBe(true);

        const status = await call<any, { cwd?: string }>(SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.success).toBe(true);
        expect(status.snapshot.repo.remotes).toEqual([
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
        const add = await call<any, { cwd?: string; name: string; fetchUrl: string }>(SCM_REMOTE_ADD, {
            cwd: '.',
            name: 'origin',
            fetchUrl: remote,
        });

        expect(add).toMatchObject({
            success: false,
            errorCode: REMOTE_ALREADY_EXISTS,
        });
    });

    it('sets fetch and push URLs independently', async () => {
        const workspace = initWorkspace();
        const originalRemote = initBareRemote('happier-git-remote-original-');
        const fetchRemote = initBareRemote('happier-git-remote-fetch-');
        const pushRemote = initBareRemote('happier-git-remote-push-');
        git(workspace, ['remote', 'add', 'origin', originalRemote]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const setUrl = await call<any, { cwd?: string; name: string; fetchUrl?: string; pushUrl?: string }>(
            SCM_REMOTE_SET_URL,
            {
                cwd: '.',
                name: 'origin',
                fetchUrl: fetchRemote,
                pushUrl: pushRemote,
            },
        );

        expect(setUrl.success).toBe(true);

        const status = await call<any, { cwd?: string }>(SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.snapshot.repo.remotes).toEqual([
            {
                name: 'origin',
                fetchUrl: fetchRemote,
                pushUrl: pushRemote,
            },
        ]);
    });

    it('clears an explicit push URL so push falls back to fetch URL', async () => {
        const workspace = initWorkspace();
        const fetchRemote = initBareRemote('happier-git-remote-clear-fetch-');
        const pushRemote = initBareRemote('happier-git-remote-clear-push-');
        git(workspace, ['remote', 'add', 'origin', fetchRemote]);
        git(workspace, ['remote', 'set-url', '--push', 'origin', pushRemote]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const setUrl = await call<any, { cwd?: string; name: string; pushUrl: null }>(SCM_REMOTE_SET_URL, {
            cwd: '.',
            name: 'origin',
            pushUrl: null,
        });

        expect(setUrl.success).toBe(true);

        const status = await call<any, { cwd?: string }>(SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.snapshot.repo.remotes).toEqual([
            {
                name: 'origin',
                fetchUrl: fetchRemote,
                pushUrl: fetchRemote,
            },
        ]);
    });

    it('removes a remote', async () => {
        const workspace = initWorkspace();
        const remote = initBareRemote('happier-git-remote-remove-');
        git(workspace, ['remote', 'add', 'origin', remote]);

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const remove = await call<any, { cwd?: string; name: string }>(SCM_REMOTE_REMOVE, {
            cwd: '.',
            name: 'origin',
        });

        expect(remove.success).toBe(true);

        const status = await call<any, { cwd?: string }>(SCM_STATUS_SNAPSHOT, { cwd: '.' });
        expect(status.snapshot.repo.remotes).toEqual([]);
    });

    it('returns remote-not-found when removing a missing remote', async () => {
        const workspace = initWorkspace();

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const remove = await call<any, { cwd?: string; name: string }>(SCM_REMOTE_REMOVE, {
            cwd: '.',
            name: 'origin',
        });

        expect(remove).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.REMOTE_NOT_FOUND,
        });
    });

    it('rejects unsafe remote management values before git sees them', async () => {
        const workspace = initWorkspace();

        const { call } = createTestRpcManager({ workingDirectory: workspace });
        const add = await call<any, { cwd?: string; name: string; fetchUrl: string }>(SCM_REMOTE_ADD, {
            cwd: '.',
            name: '--upload-pack=hack',
            fetchUrl: '--upload-pack=hack',
        });

        expect(add).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(git(workspace, ['remote'])).toBe('');
    });
});
