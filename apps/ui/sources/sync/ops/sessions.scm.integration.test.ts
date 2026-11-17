import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol/scm/operationError';

// test-policy-boundary: model the person's confirmation at the native/web modal presentation boundary.
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);

// HTTP, Socket.IO and device credential storage are the external boundaries.
// Session targeting, path resolution, Account admission and SCM Actions stay real.
const { installSessionOpsNetworkBoundary } = await import('@/dev/testkit/harness/sessionOpsNetworkBoundary');
const boundary = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { serveSessionActionHome } = await import('@/dev/testkit/harness/sessionActionHome');
const { createSessionFixture, createPlainSessionCurrentProjectionRecordFixture } = await import('@/dev/testkit/fixtures/sessionFixtures');
const { createEmptyAccountBootstrapHttpResponse } = await import('@/dev/testkit/fixtures/accountBootstrapHttpBoundary');
const { createHydratedPlainMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
const { ActionsSettingsV1Schema } = await import('@happier-dev/protocol/actions/actionSettings');
const { SCM_GIT_ACTION_SPECS } = await import('@happier-dev/protocol/actions/scmGitActionSpecs');
const { socketRpcCodec } = await import('@happier-dev/sync-client');
const { storage } = await import('../domains/state/storage');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const nativeRpc = vi.fn<(sessionId: string, method: string, request: unknown) => Promise<unknown>>();
let actionHome: Awaited<ReturnType<typeof serveSessionActionHome>> | undefined;
let sessionRecord = createPlainSessionCurrentProjectionRecordFixture();
let serverId = '';

function publishWorkspace(workspace: string) {
    const metadata = { path: workspace, host: 'tester.local', machineId: 'machine-1' };
    sessionRecord = createPlainSessionCurrentProjectionRecordFixture({ id: 'session-1', active: true, metadata });
    const machine = createHydratedPlainMachineFixture({ id: 'machine-1', accountId: 'scm-account',
        machine: { activeAt: Date.now() } });
    storage.setState({ sessions: { 'session-1': createSessionFixture({ id: 'session-1', serverId, active: true, metadata }) },
        machines: { [machine.id]: machine }, machineListByServerId: { [serverId]: [machine] } });
}

beforeEach(async () => {
    boundary.resetRequests();
    nativeRpc.mockReset();
    resetScopedMachineTransportCacheForTests();
    const serverUrl = 'https://scm.example.test';
    const serverIdentityId = 'srv_scm_home';
    await boundary.addHome(serverUrl, 'scm-account', { serverIdentityId });
    const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: {},
        approvalWaivedSurfaces: Object.fromEntries(SCM_GIT_ACTION_SPECS.map(spec => [spec.id, ['ui']])),
    });
    actionHome = await serveSessionActionHome({ homes: [{ key: 'scm', serverUrl, serverIdentityId,
        accountId: 'scm-account', currentAccount: true, settings: { actionsSettingsV1 } }],
        route: async request => {
            if (request.path === '/v2/sessions' || request.path === '/v2/sessions/active') {
                return Response.json({ sessions: [sessionRecord], nextCursor: null, hasNext: false });
            }
            if (request.path === '/v2/sessions/session-1') return Response.json({ session: sessionRecord });
            const init = { method: request.method, headers: request.headers,
                ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }), signal: request.signal };
            if (request.path === '/v1/machines' || request.path.startsWith('/v1/machines/')) {
                return await boundary.request(request.url, init);
            }
            return createEmptyAccountBootstrapHttpResponse(request.url.pathname + request.url.search, init) ?? undefined;
        },
    });
    serverId = actionHome.homes.scm!.id;
    publishWorkspace(tmpdir());
    boundary.setRpcResponder(async request => {
        expect(request.targetId).toBe('machine-1');
        const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload,
            `${request.targetId}:${request.method}`);
        const result = await nativeRpc('session-1', request.method, decoded.params);
        return socketRpcCodec.encodeResponse({ mode: 'plain' }, result, decoded.callId);
    });
});
afterEach(async () => {
    await serverScopedRpcSocketPool.stopAll();
    await resetServerReachabilitySupervisors();
    await actionHome?.dispose();
    actionHome = undefined;
});
afterAll(() => boundary.dispose());

const {
    sessionScmCommitCreate,
    sessionScmCommitBackout,
    sessionScmLogList,
    sessionScmRemoteFetch,
    sessionScmRemotePull,
    sessionScmRemotePush,
    sessionScmChangeDiscard,
    sessionScmChangeInclude,
    sessionScmStatusSnapshot,
} = await import('./sessions');
import { createGitSessionRpcHarness, git, initBareRemote, initRepo } from './__tests__/gitRepoHarness';

/** Refusals count only after this repository is readable through the same real Home/Socket. */
async function serveRepository(workspace: string) {
    publishWorkspace(workspace);
    nativeRpc.mockImplementation(createGitSessionRpcHarness(workspace));
    const control = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
    expect(control).toMatchObject({ success: true });
}

describe('session scm ops integration (git backend)', () => {
    beforeEach(() => {
        storage.getState().applySettingsLocal({ scmGitRepoPreferredBackend: 'git' });
    });

    it('injects sapling backend preference when configured', async () => {
        storage.getState().applySettingsLocal({ scmGitRepoPreferredBackend: 'sapling' });
        nativeRpc.mockResolvedValue({
            success: true,
            snapshot: {
                projectKey: 'local:/repo',
                fetchedAt: Date.now(),
                repo: { isRepo: false, rootPath: null, backendId: null, mode: null },
                capabilities: {
                    readStatus: false,
                    readDiffFile: false,
                    readDiffCommit: false,
                    readLog: false,
                    writeInclude: false,
                    writeExclude: false,
                    writeCommit: false,
                    writeBackout: false,
                    writeRemoteFetch: false,
                    writeRemotePull: false,
                    writeRemotePush: false,
                    worktreeCreate: false,
                    changeSetModel: 'working-copy',
                    supportedDiffAreas: ['pending'],
                },
                branch: { head: null, upstream: null, ahead: 0, behind: 0, detached: false },
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
            },
        });

        await sessionScmStatusSnapshot('session-1', { cwd: '.' });

        const request = nativeRpc.mock.calls[0]?.[2];
        expect(request).toMatchObject({
            backendPreference: { kind: 'prefer', backendId: 'sapling' },
        });
    });

    it('stages, commits, and lists history through session git RPC methods', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-int-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nupdate\n');

        await serveRepository(workspace);

        const stage = await sessionScmChangeInclude('session-1', {
            cwd: '.',
            paths: ['a.txt'],
        });
        assert(stage.success === true);
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('a.txt');

        const stagedSnapshot = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
        assert(stagedSnapshot.success === true);
        expect(stagedSnapshot.snapshot?.totals.includedFiles).toBe(1);
        expect(stagedSnapshot.snapshot?.totals.pendingFiles).toBe(0);

        const commit = await sessionScmCommitCreate('session-1', {
            cwd: '.',
            message: 'feat: update a',
        });
        assert(commit.success === true);
        expect(commit.commitSha).toBeTruthy();

        const log = await sessionScmLogList('session-1', {
            cwd: '.',
            limit: 1,
            skip: 0,
        });
        assert(log.success === true);
        expect(log.entries?.[0]?.subject).toBe('feat: update a');

        const status = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
        assert(status.success === true);
        expect(status.snapshot?.totals.includedFiles).toBe(0);
        expect(status.snapshot?.totals.pendingFiles).toBe(0);
    });

    it('discards file changes through sessionScmChangeDiscard', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-int-discard-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'changed\n');
        writeFileSync(join(workspace, 'b.txt'), 'tmp\n');

        await serveRepository(workspace);

        const discard = await sessionScmChangeDiscard('session-1', {
            cwd: '.',
            entries: [
                { path: 'a.txt', kind: 'modified' },
                { path: 'b.txt', kind: 'untracked' },
            ],
        });
        assert(discard.success === true);

        const status = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
        assert(status.success === true);
        expect(status.snapshot?.totals.pendingFiles).toBe(0);
        expect(status.snapshot?.totals.untrackedFiles).toBe(0);
    });

    it('commits all pending tracked and untracked changes with all-pending scope', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-int-atomic-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);

        writeFileSync(join(workspace, 'a.txt'), 'base\ntracked-pending\n');
        writeFileSync(join(workspace, 'untracked.txt'), 'untracked\n');

        await serveRepository(workspace);

        const commit = await sessionScmCommitCreate('session-1', {
            cwd: '.',
            message: 'feat: atomic all pending',
            scope: { kind: 'all-pending' },
        });
        assert(commit.success === true);
        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toContain('a.txt');
        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toContain('untracked.txt');

        const status = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
        assert(status.success === true);
        expect(status.snapshot?.totals.pendingFiles).toBe(0);
        expect(status.snapshot?.totals.untrackedFiles).toBe(0);
    });

    it('fetches remote updates through sessionScmRemoteFetch against a real remote', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);

        const other = mkdtempSync(join(tmpdir(), 'happier-ui-git-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'other@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'remote.txt'), 'remote\n');
        git(other, ['add', 'remote.txt']);
        git(other, ['commit', '-m', 'remote update']);
        git(other, ['push', 'origin', branch]);
        const remoteHead = git(other, ['rev-parse', 'HEAD']);

        await serveRepository(workspace);

        const fetch = await sessionScmRemoteFetch('session-1', {
            cwd: '.',
            remote: 'origin',
        });
        assert(fetch.success === true);
        expect(git(workspace, ['rev-parse', `origin/${branch}`])).toBe(remoteHead);
    });

    it('rejects push when local branch is behind upstream', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);

        const other = mkdtempSync(join(tmpdir(), 'happier-ui-git-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'other@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'remote.txt'), 'remote\n');
        git(other, ['add', 'remote.txt']);
        git(other, ['commit', '-m', 'remote update']);
        git(other, ['push', 'origin', branch]);

        await serveRepository(workspace);

        const fetch = await sessionScmRemoteFetch('session-1', {
            cwd: '.',
            remote: 'origin',
        });
        assert(fetch.success === true);

        const push = await sessionScmRemotePush('session-1', { cwd: '.' });
        expect(push.success).toBe(false);
        expect(push.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_NON_FAST_FORWARD);
    });

    it('rejects pull when worktree is dirty', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);
        writeFileSync(join(workspace, 'a.txt'), 'base\ndirty\n');

        await serveRepository(workspace);

        const pull = await sessionScmRemotePull('session-1', { cwd: '.' });
        expect(pull.success).toBe(false);
        expect(pull.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
    });

    it('pushes successfully when local branch is ahead of upstream', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);

        writeFileSync(join(workspace, 'ahead.txt'), 'ahead\n');
        git(workspace, ['add', 'ahead.txt']);
        git(workspace, ['commit', '-m', 'ahead']);
        const localHead = git(workspace, ['rev-parse', 'HEAD']);

        await serveRepository(workspace);

        const push = await sessionScmRemotePush('session-1', { cwd: '.' });
        assert(push.success === true);
        expect(git(workspace, ['rev-parse', `origin/${branch}`])).toBe(localHead);
    });

    it('returns REMOTE_FF_ONLY_REQUIRED when pull cannot fast-forward', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);

        writeFileSync(join(workspace, 'local.txt'), 'local\n');
        git(workspace, ['add', 'local.txt']);
        git(workspace, ['commit', '-m', 'local change']);

        const other = mkdtempSync(join(tmpdir(), 'happier-ui-git-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'other@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'remote.txt'), 'remote\n');
        git(other, ['add', 'remote.txt']);
        git(other, ['commit', '-m', 'remote change']);
        git(other, ['push', 'origin', branch]);

        await serveRepository(workspace);

        const fetch = await sessionScmRemoteFetch('session-1', {
            cwd: '.',
            remote: 'origin',
        });
        assert(fetch.success === true);

        const pull = await sessionScmRemotePull('session-1', { cwd: '.' });
        expect(pull.success).toBe(false);
        expect(pull.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_FF_ONLY_REQUIRED);
    });

    it('blocks push without upstream when remote/branch are not provided', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);

        await serveRepository(workspace);

        const push = await sessionScmRemotePush('session-1', { cwd: '.' });
        expect(push.success).toBe(false);
        expect(push.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
    });

    it('blocks pull without upstream when remote/branch are not provided', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);

        await serveRepository(workspace);

        const pull = await sessionScmRemotePull('session-1', { cwd: '.' });
        expect(pull.success).toBe(false);
        expect(pull.errorCode).toBe(SCM_OPERATION_ERROR_CODES.REMOTE_UPSTREAM_REQUIRED);
    });

    it('pushes with explicit remote/branch even when upstream is not configured', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);

        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const localHead = git(workspace, ['rev-parse', 'HEAD']);
        await serveRepository(workspace);

        const push = await sessionScmRemotePush('session-1', {
            cwd: '.',
            remote: 'origin',
            branch,
        });
        assert(push.success === true);
        expect(git(workspace, ['rev-parse', `origin/${branch}`])).toBe(localHead);
    });

    it('pulls with explicit remote/branch even when upstream is not configured', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', 'origin', branch]);

        const other = mkdtempSync(join(tmpdir(), 'happier-ui-git-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'other@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'remote.txt'), 'remote\n');
        git(other, ['add', 'remote.txt']);
        git(other, ['commit', '-m', 'remote update']);
        git(other, ['push', 'origin', branch]);
        const remoteHead = git(other, ['rev-parse', 'HEAD']);

        await serveRepository(workspace);

        const pull = await sessionScmRemotePull('session-1', {
            cwd: '.',
            remote: 'origin',
            branch,
        });
        assert(pull.success === true);
        expect(git(workspace, ['rev-parse', 'HEAD'])).toBe(remoteHead);
    });

    it('blocks push while HEAD is detached', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);
        git(workspace, ['checkout', '--detach']);

        await serveRepository(workspace);

        const push = await sessionScmRemotePush('session-1', {
            cwd: '.',
            remote: 'origin',
            branch,
        });
        expect(push.success).toBe(false);
        expect(push.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('blocks pull while HEAD is detached', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-git-remote-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);
        git(workspace, ['checkout', '--detach']);

        await serveRepository(workspace);

        const pull = await sessionScmRemotePull('session-1', {
            cwd: '.',
            remote: 'origin',
            branch,
        });
        expect(pull.success).toBe(false);
        expect(pull.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });

    it('returns CHANGE_APPLY_FAILED when selected patch no longer matches index state', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-int-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'a\nb\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'X\nB\n');
        git(workspace, ['add', 'a.txt']);

        await serveRepository(workspace);

        const patch = [
            'diff --git a/a.txt b/a.txt',
            '--- a/a.txt',
            '+++ b/a.txt',
            '@@ -1 +1 @@',
            '-a',
            '+A',
            '',
        ].join('\n');

        const stage = await sessionScmChangeInclude('session-1', {
            cwd: '.',
            patch,
        });
        expect(stage.success).toBe(false);
        expect(stage.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CHANGE_APPLY_FAILED);
    });

    it('returns NOT_REPOSITORY for operations outside a repository and keeps snapshot responses safe', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-empty-'));
        await serveRepository(workspace);

        const stage = await sessionScmChangeInclude('session-1', {
            cwd: '.',
            paths: ['a.txt'],
        });
        expect(stage.success).toBe(false);
        expect(stage.errorCode).toBe(SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY);

        const snapshot = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
        assert(snapshot.success === true);
        expect(snapshot.snapshot?.repo.isRepo).toBe(false);
        expect(snapshot.snapshot?.entries).toEqual([]);
    });

    it('retains an unknown pull outcome when the Socket transport fails', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-transport-'));
        initRepo(workspace);
        await serveRepository(workspace);
        nativeRpc.mockRejectedValue(new Error('socket disconnected'));

        const result = await sessionScmRemotePull('session-1', { cwd: '.' });
        expect(result).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_OUTCOME_UNKNOWN,
            outcome: { kind: 'outcome_unknown', reconciliation: { kind: 'repository_status', cwd: workspace },
                nextActions: [{ kind: 'refresh' }] },
        });
        expect(JSON.stringify(result)).not.toContain('socket disconnected');
    });

    it('reverts a regular commit successfully', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-revert-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'changed\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'feature change']);
        const targetSha = git(workspace, ['rev-parse', 'HEAD']);

        await serveRepository(workspace);

        const response = await sessionScmCommitBackout('session-1', {
            cwd: '.',
            commit: targetSha,
        });
        assert(response.success === true);
        expect(git(workspace, ['log', '-1', '--pretty=%s']).toLowerCase()).toContain('revert');
        expect(git(workspace, ['show', 'HEAD:a.txt'])).toBe('base');
    });

    it('blocks revert when worktree has local changes', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-revert-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'changed\n');

        await serveRepository(workspace);

        const response = await sessionScmCommitBackout('session-1', {
            cwd: '.',
            commit: 'HEAD',
        });
        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.CONFLICTING_WORKTREE);
    });

    it('returns deterministic error for reverting a merge commit', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-revert-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        const defaultBranch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['checkout', '-b', 'feature']);
        writeFileSync(join(workspace, 'feature.txt'), 'feature\n');
        git(workspace, ['add', 'feature.txt']);
        git(workspace, ['commit', '-m', 'feature']);
        git(workspace, ['checkout', defaultBranch]);
        writeFileSync(join(workspace, 'main.txt'), 'main\n');
        git(workspace, ['add', 'main.txt']);
        git(workspace, ['commit', '-m', 'main']);
        git(workspace, ['merge', '--no-ff', 'feature', '-m', 'merge feature']);
        const mergeSha = git(workspace, ['rev-parse', 'HEAD']);

        await serveRepository(workspace);

        const response = await sessionScmCommitBackout('session-1', {
            cwd: '.',
            commit: mergeSha,
        });
        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
        expect((response.error || '').toLowerCase()).toContain('merge commit');
    });

    it('blocks revert while HEAD is detached', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-git-revert-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['checkout', '--detach']);

        await serveRepository(workspace);

        const response = await sessionScmCommitBackout('session-1', {
            cwd: '.',
            commit: 'HEAD',
        });
        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_REQUEST);
    });
});
