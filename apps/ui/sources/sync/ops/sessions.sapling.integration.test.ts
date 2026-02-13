import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

const { mockSessionRPC } = vi.hoisted(() => ({
    mockSessionRPC: vi.fn(),
}));

vi.mock('../api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: mockSessionRPC,
    },
}));

vi.mock('../sync', () => ({
    sync: {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
        },
    },
}));

import {
    sessionScmChangeExclude,
    sessionScmChangeInclude,
    sessionScmCommitBackout,
    sessionScmCommitCreate,
    sessionScmDiffCommit,
    sessionScmDiffFile,
    sessionScmLogList,
    sessionScmRemoteFetch,
    sessionScmRemotePull,
    sessionScmRemotePush,
    sessionScmStatusSnapshot,
} from './sessions';
import { createSaplingSessionRpcHarness, initSaplingRepo, runSapling } from './__tests__/saplingRepoHarness';
import { git, initBareRemote } from './__tests__/gitRepoHarness';

describe('session scm ops integration (sapling)', () => {
    beforeEach(() => {
        mockSessionRPC.mockReset();
    });

    it('returns sapling snapshots and file/commit diffs for .sl repositories', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-sapling-int-'));
        initSaplingRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        runSapling(workspace, ['add', 'a.txt']);
        runSapling(workspace, ['commit', '-m', 'init']);
        const base = runSapling(workspace, ['whereami']);
        writeFileSync(join(workspace, 'a.txt'), 'hello2\n');

        mockSessionRPC.mockImplementation(createSaplingSessionRpcHarness(workspace));

        const status = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
        expect(status.success).toBe(true);
        expect(status.snapshot?.repo.backendId).toBe('sapling');
        expect(status.snapshot?.repo.mode).toBe('.sl');
        expect(status.snapshot?.totals.pendingFiles).toBe(1);

        const fileDiff = await sessionScmDiffFile('session-1', {
            cwd: '.',
            path: 'a.txt',
            area: 'pending',
        });
        expect(fileDiff.success).toBe(true);
        expect(fileDiff.diff).toContain('diff --git a/a.txt b/a.txt');

        const commitDiff = await sessionScmDiffCommit('session-1', {
            cwd: '.',
            commit: base,
        });
        expect(commitDiff.success).toBe(true);
        expect(commitDiff.diff).toContain('diff --git a/a.txt b/a.txt');
    });

    it('returns FEATURE_UNSUPPORTED for include/exclude operations', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-sapling-include-'));
        initSaplingRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');

        mockSessionRPC.mockImplementation(createSaplingSessionRpcHarness(workspace));

        const include = await sessionScmChangeInclude('session-1', {
            cwd: '.',
            paths: ['a.txt'],
        });
        const exclude = await sessionScmChangeExclude('session-1', {
            cwd: '.',
            paths: ['a.txt'],
        });

        expect(include.success).toBe(false);
        expect(include.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
        expect(exclude.success).toBe(false);
        expect(exclude.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
    });

    it('creates commits and lists history entries', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-sapling-commit-'));
        initSaplingRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');

        mockSessionRPC.mockImplementation(createSaplingSessionRpcHarness(workspace));

        const commit = await sessionScmCommitCreate('session-1', {
            cwd: '.',
            message: 'init',
        });
        expect(commit.success).toBe(true);
        expect(typeof commit.commitSha).toBe('string');

        const status = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
        expect(status.success).toBe(true);
        expect(status.snapshot?.totals.pendingFiles).toBe(0);

        const log = await sessionScmLogList('session-1', {
            cwd: '.',
            limit: 10,
            skip: 0,
        });
        expect(log.success).toBe(true);
        expect(log.entries?.[0]?.subject).toBe('init');
    });

    it('supports log pagination with skip and limit', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-sapling-log-'));
        initSaplingRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'one\n');
        runSapling(workspace, ['commit', '-A', '-m', 'one']);
        writeFileSync(join(workspace, 'a.txt'), 'two\n');
        runSapling(workspace, ['commit', '-A', '-m', 'two']);
        writeFileSync(join(workspace, 'a.txt'), 'three\n');
        runSapling(workspace, ['commit', '-A', '-m', 'three']);

        mockSessionRPC.mockImplementation(createSaplingSessionRpcHarness(workspace));

        const firstPage = await sessionScmLogList('session-1', {
            cwd: '.',
            limit: 1,
            skip: 0,
        });
        const secondPage = await sessionScmLogList('session-1', {
            cwd: '.',
            limit: 1,
            skip: 1,
        });

        expect(firstPage.success).toBe(true);
        expect(secondPage.success).toBe(true);
        expect(firstPage.entries?.[0]?.subject).toBe('three');
        expect(secondPage.entries?.[0]?.subject).toBe('two');
    });

    it('backs out a non-merge commit', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-sapling-backout-'));
        initSaplingRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        runSapling(workspace, ['add', 'a.txt']);
        runSapling(workspace, ['commit', '-m', 'init']);

        writeFileSync(join(workspace, 'a.txt'), 'hello2\n');
        runSapling(workspace, ['commit', '-A', '-m', 'update']);
        const commitToBackout = runSapling(workspace, ['whereami']);

        mockSessionRPC.mockImplementation(createSaplingSessionRpcHarness(workspace));

        const backout = await sessionScmCommitBackout('session-1', {
            cwd: '.',
            commit: commitToBackout,
        });
        expect(backout.success).toBe(true);

        const status = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
        expect(status.success).toBe(true);
        expect(status.snapshot?.totals.pendingFiles).toBe(0);
    });

    it('returns deterministic upstream-required errors for pull/push without bookmark target', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-sapling-remote-'));
        initSaplingRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        runSapling(workspace, ['commit', '-A', '-m', 'init']);

        mockSessionRPC.mockImplementation(createSaplingSessionRpcHarness(workspace));

        const pull = await sessionScmRemotePull('session-1', { cwd: '.' });
        const push = await sessionScmRemotePush('session-1', { cwd: '.' });

        expect(pull.success).toBe(false);
        expect(pull.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
        expect(push.success).toBe(false);
        expect(push.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
    });

    it('fetches, pulls, and pushes against git remotes using branch shorthand', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-sapling-remote-ok-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-sapling-remote-workspace-'));
        initSaplingRepo(workspace);
        runSapling(workspace, ['path', '--add', 'origin', remote]);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        runSapling(workspace, ['commit', '-A', '-m', 'init']);
        runSapling(workspace, ['push', 'origin', '--to', 'main', '--create']);

        const other = mkdtempSync(join(tmpdir(), 'happier-ui-sapling-remote-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'other@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'remote.txt'), 'remote\n');
        git(other, ['add', 'remote.txt']);
        git(other, ['commit', '-m', 'remote update']);
        git(other, ['push', 'origin', 'main']);

        mockSessionRPC.mockImplementation(createSaplingSessionRpcHarness(workspace));

        const fetch = await sessionScmRemoteFetch('session-1', {
            cwd: '.',
            remote: 'origin',
        });
        expect(fetch.success).toBe(true);

        const pull = await sessionScmRemotePull('session-1', {
            cwd: '.',
            remote: 'origin',
            branch: 'main',
        });
        expect(pull.success).toBe(true);
        expect(readFileSync(join(workspace, 'remote.txt'), 'utf8')).toBe('remote\n');

        writeFileSync(join(workspace, 'local.txt'), 'local\n');
        runSapling(workspace, ['commit', '-A', '-m', 'local update']);

        const push = await sessionScmRemotePush('session-1', {
            cwd: '.',
            remote: 'origin',
            branch: 'main',
        });
        expect(push.success).toBe(true);

        const remoteHead = git(remote, ['rev-parse', 'refs/heads/main']);
        const localHead = runSapling(workspace, ['whereami']);
        expect(remoteHead).toBe(localHead);
    });
});
