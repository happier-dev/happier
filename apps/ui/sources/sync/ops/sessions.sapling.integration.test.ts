import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
} = await import('./sessions');
import { createSaplingSessionRpcHarness, initSaplingRepo, runSapling } from './__tests__/saplingRepoHarness';
import { git, initBareRemote } from './__tests__/gitRepoHarness';

/** Refusals count only after this repository is readable through the same real Home/Socket. */
async function serveRepository(workspace: string) {
    publishWorkspace(workspace);
    nativeRpc.mockImplementation(createSaplingSessionRpcHarness(workspace));
    const control = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
    expect(control).toMatchObject({ success: true });
}

describe('session scm ops integration (sapling)', () => {
    beforeEach(() => {
        storage.getState().applySettingsLocal({ scmGitRepoPreferredBackend: 'sapling' });
    });

    it('returns sapling snapshots and file/commit diffs for .sl repositories', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-sapling-int-'));
        initSaplingRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        runSapling(workspace, ['add', 'a.txt']);
        runSapling(workspace, ['commit', '-m', 'init']);
        const base = runSapling(workspace, ['whereami']);
        writeFileSync(join(workspace, 'a.txt'), 'hello2\n');

        await serveRepository(workspace);

        const status = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
        assert(status.success === true);
        expect(status.snapshot?.repo.backendId).toBe('sapling');
        expect(status.snapshot?.repo.mode).toBe('.sl');
        expect(status.snapshot?.totals.pendingFiles).toBe(1);

        const fileDiff = await sessionScmDiffFile('session-1', {
            cwd: '.',
            path: 'a.txt',
            area: 'pending',
        });
        assert(fileDiff.success === true);
        expect(fileDiff.diff).toContain('diff --git a/a.txt b/a.txt');

        const commitDiff = await sessionScmDiffCommit('session-1', {
            cwd: '.',
            commit: base,
        });
        assert(commitDiff.success === true);
        expect(commitDiff.diff).toContain('diff --git a/a.txt b/a.txt');
    });

    it('returns FEATURE_UNSUPPORTED for include/exclude operations', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-sapling-include-'));
        initSaplingRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');

        await serveRepository(workspace);

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

        await serveRepository(workspace);

        const commit = await sessionScmCommitCreate('session-1', {
            cwd: '.',
            message: 'init',
        });
        assert(commit.success === true);
        expect(typeof commit.commitSha).toBe('string');

        const status = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
        assert(status.success === true);
        expect(status.snapshot?.totals.pendingFiles).toBe(0);

        const log = await sessionScmLogList('session-1', {
            cwd: '.',
            limit: 10,
            skip: 0,
        });
        assert(log.success === true);
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

        await serveRepository(workspace);

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

        assert(firstPage.success === true);
        assert(secondPage.success === true);
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

        await serveRepository(workspace);

        const backout = await sessionScmCommitBackout('session-1', {
            cwd: '.',
            commit: commitToBackout,
        });
        assert(backout.success === true);

        const status = await sessionScmStatusSnapshot('session-1', { cwd: '.' });
        assert(status.success === true);
        expect(status.snapshot?.totals.pendingFiles).toBe(0);
    });

    it('returns deterministic upstream-required errors for pull/push without bookmark target', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-sapling-remote-'));
        initSaplingRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        runSapling(workspace, ['commit', '-A', '-m', 'init']);

        await serveRepository(workspace);

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

        await serveRepository(workspace);

        const fetch = await sessionScmRemoteFetch('session-1', {
            cwd: '.',
            remote: 'origin',
        });
        assert(fetch.success === true);

        const pull = await sessionScmRemotePull('session-1', {
            cwd: '.',
            remote: 'origin',
            branch: 'main',
        });
        assert(pull.success === true);
        expect(readFileSync(join(workspace, 'remote.txt'), 'utf8')).toBe('remote\n');

        writeFileSync(join(workspace, 'local.txt'), 'local\n');
        runSapling(workspace, ['commit', '-A', '-m', 'local update']);

        const push = await sessionScmRemotePush('session-1', {
            cwd: '.',
            remote: 'origin',
            branch: 'main',
        });
        assert(push.success === true);

        const remoteHead = git(remote, ['rev-parse', 'refs/heads/main']);
        const localHead = runSapling(workspace, ['whereami']);
        expect(remoteHead).toBe(localHead);
    });
});
