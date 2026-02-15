import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
    mockSessionRPC,
    modalAlert,
    modalConfirm,
    modalPrompt,
    invalidateFromMutationAndAwait,
    trackingCapture,
} = vi.hoisted(() => ({
    mockSessionRPC: vi.fn(),
    modalAlert: vi.fn(),
    modalConfirm: vi.fn(),
    modalPrompt: vi.fn(),
    invalidateFromMutationAndAwait: vi.fn(async () => {}),
    trackingCapture: vi.fn(),
}));

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        sessionRPC: mockSessionRPC,
    },
}));

// sessions ops import sync for non-git helpers; keep this test node-safe.
vi.mock('@/sync/sync', () => ({
    sync: {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
        },
    },
}));

vi.mock('@/modal', () => ({
    Modal: {
        alert: modalAlert,
        confirm: modalConfirm,
        prompt: modalPrompt,
    },
}));

vi.mock('@/scm/scmStatusSync', () => ({
    scmStatusSync: {
        invalidateFromMutationAndAwait,
    },
}));

vi.mock('@/track', () => ({
    tracking: {
        capture: trackingCapture,
    },
}));

import { sessionScmStatusSnapshot } from '@/sync/ops';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { storage } from '@/sync/domains/state/storage';
import { createGitSessionRpcHarness, git, initBareRemote, initRepo } from '@/sync/ops/__tests__/gitRepoHarness';
import { createSaplingSessionRpcHarness, initSaplingRepo, runSapling } from '@/sync/ops/__tests__/saplingRepoHarness';
import { normalizeWorkingSnapshotForUi } from '@/scm/scmRepositoryService';
import { useFilesScmOperations } from './useFilesScmOperations';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = storage.getState();

type HookProps = Parameters<typeof useFilesScmOperations>[0];

function createSession(sessionId: string, workspacePath: string) {
    const now = Date.now();
    return {
        id: sessionId,
        seq: 1,
        createdAt: now,
        updatedAt: now,
        active: true,
        activeAt: now,
        metadata: {
            machineId: 'machine-1',
            path: workspacePath,
            host: 'localhost',
            version: '1.0.0',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online' as const,
        optimisticThinkingAt: null,
    };
}

function mountHook(props: HookProps) {
    let current: ReturnType<typeof useFilesScmOperations> | null = null;

    function Probe() {
        current = useFilesScmOperations(props);
        return React.createElement('View');
    }

    let tree: renderer.ReactTestRenderer;
    act(() => {
        tree = renderer.create(React.createElement(Probe));
    });

    return {
        getCurrent() {
            if (!current) {
                throw new Error('Hook state is unavailable');
            }
            return current;
        },
        unmount() {
            tree.unmount();
        },
    };
}

describe('useFilesScmOperations integration', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        projectManager.clear();

        mockSessionRPC.mockReset();
        modalAlert.mockReset();
        modalConfirm.mockReset();
        modalPrompt.mockReset();
        invalidateFromMutationAndAwait.mockReset();
        invalidateFromMutationAndAwait.mockImplementation(async () => {});
        trackingCapture.mockReset();

        modalConfirm.mockResolvedValue(true);
        modalPrompt.mockResolvedValue('feat: hook integration commit');
    });

    it('creates a commit then pushes successfully against a real remote', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-hook-remote-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);

        writeFileSync(join(workspace, 'a.txt'), 'base\nupdate\n');
        git(workspace, ['add', 'a.txt']);

        const sessionId = 'session-hook-1';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const refreshScmData = vi.fn(async () => {});
        const loadCommitHistory = vi.fn(async () => {});

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            scmCommitStrategy: 'git_staging',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
            refreshScmData,
            loadCommitHistory,
        });

        await act(async () => {
            await hook.getCurrent().createCommit();
        });

        expect(git(workspace, ['log', '-1', '--pretty=%s'])).toBe('feat: hook integration commit');

        const localHeadAfterCommit = git(workspace, ['rev-parse', 'HEAD']);
        expect(git(workspace, ['rev-parse', `origin/${branch}`])).not.toBe(localHeadAfterCommit);

        await act(async () => {
            await hook.getCurrent().runRemoteOperation('push');
        });

        expect(git(workspace, ['rev-parse', `origin/${branch}`])).toBe(localHeadAfterCommit);
        expect(invalidateFromMutationAndAwait).toHaveBeenCalledTimes(2);
        expect(loadCommitHistory).toHaveBeenNthCalledWith(1, { reset: true });
        expect(loadCommitHistory).toHaveBeenNthCalledWith(2, { reset: true });
        expect(refreshScmData).not.toHaveBeenCalled();
        expect(modalConfirm).toHaveBeenCalledTimes(1);
        expect(modalAlert).not.toHaveBeenCalled();

        const operationLog = storage.getState().getSessionProjectScmOperationLog(sessionId);
        expect(operationLog.some((entry) => entry.operation === 'commit' && entry.status === 'success')).toBe(true);
        expect(operationLog.some((entry) => entry.operation === 'push' && entry.status === 'success')).toBe(true);

        act(() => {
            hook.unmount();
        });
    });

    it('creates an atomic commit from pending changes without touching live index staging', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-atomic-commit-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\natomic\n');

        const sessionId = 'session-hook-atomic-1';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const refreshScmData = vi.fn(async () => {});
        const loadCommitHistory = vi.fn(async () => {});

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            refreshScmData,
            loadCommitHistory,
            scmCommitStrategy: 'atomic',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
        } as any);

        await act(async () => {
            await hook.getCurrent().createCommit();
        });

        const commitCall = mockSessionRPC.mock.calls.find((call) => call[1] === RPC_METHODS.SCM_COMMIT_CREATE);
        expect(commitCall?.[2]?.scope).toEqual({ kind: 'all-pending' });
        expect(git(workspace, ['log', '-1', '--pretty=%s'])).toBe('feat: hook integration commit');
        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toContain('a.txt');
        expect(git(workspace, ['diff', '--name-only'])).toBe('');
        expect(modalAlert).not.toHaveBeenCalled();

        act(() => {
            hook.unmount();
        });
    });

    it('creates all-pending atomic commit with unstaged, pre-staged, and untracked changes', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-atomic-commit-mixed-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\n');
        git(workspace, ['add', 'a.txt', 'b.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base-a\nnext-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\nnext-b\n');
        writeFileSync(join(workspace, 'c.txt'), 'new-c\n');
        git(workspace, ['add', 'b.txt']);

        const sessionId = 'session-hook-atomic-mixed';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            refreshScmData: vi.fn(async () => {}),
            loadCommitHistory: vi.fn(async () => {}),
            scmCommitStrategy: 'atomic',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
        } as any);

        await act(async () => {
            await hook.getCurrent().createCommit();
        });

        const commitCall = mockSessionRPC.mock.calls.find((call) => call[1] === RPC_METHODS.SCM_COMMIT_CREATE);
        expect(commitCall?.[2]?.scope).toEqual({ kind: 'all-pending' });

        const committedPaths = git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])
            .split('\n')
            .map((path) => path.trim())
            .filter(Boolean)
            .sort();
        expect(committedPaths).toEqual(['a.txt', 'b.txt', 'c.txt']);
        expect(git(workspace, ['diff', '--name-only'])).toBe('');
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('');

        act(() => {
            hook.unmount();
        });
    });

    it('creates a path-scoped atomic commit when commit selection paths are present', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-atomic-selection-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\n');
        git(workspace, ['add', 'a.txt', 'b.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base-a\nchanged-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\nchanged-b\n');

        const sessionId = 'session-hook-atomic-selection';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        storage.getState().markSessionProjectScmCommitSelectionPaths(sessionId, ['a.txt']);

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            refreshScmData: vi.fn(async () => {}),
            loadCommitHistory: vi.fn(async () => {}),
            scmCommitStrategy: 'atomic',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
        } as any);

        await act(async () => {
            await hook.getCurrent().createCommit();
        });

        const commitCall = mockSessionRPC.mock.calls.find((call) => call[1] === RPC_METHODS.SCM_COMMIT_CREATE);
        expect(commitCall?.[2]?.scope).toEqual({ kind: 'paths', include: ['a.txt'] });
        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('a.txt');
        expect(git(workspace, ['diff', '--name-only'])).toBe('b.txt');
        expect(storage.getState().getSessionProjectScmCommitSelectionPaths(sessionId)).toEqual([]);

        act(() => {
            hook.unmount();
        });
    });

    it('creates path-scoped atomic commit without consuming unrelated pre-staged repository state', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-atomic-selection-prestaged-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\n');
        git(workspace, ['add', 'a.txt', 'b.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base-a\nchanged-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\nchanged-b\n');
        git(workspace, ['add', 'b.txt']);

        const sessionId = 'session-hook-atomic-selection-prestaged';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        storage.getState().markSessionProjectScmCommitSelectionPaths(sessionId, ['a.txt']);

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            refreshScmData: vi.fn(async () => {}),
            loadCommitHistory: vi.fn(async () => {}),
            scmCommitStrategy: 'atomic',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
        } as any);

        await act(async () => {
            await hook.getCurrent().createCommit();
        });

        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('a.txt');
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('b.txt');

        act(() => {
            hook.unmount();
        });
    });

    it('keeps virtual commit selection when post-commit refresh fails', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-atomic-selection-refresh-fail-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\n');
        git(workspace, ['add', 'a.txt', 'b.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base-a\nchanged-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\nchanged-b\n');

        const sessionId = 'session-hook-atomic-selection-refresh-fail';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        storage.getState().markSessionProjectScmCommitSelectionPaths(sessionId, ['a.txt']);
        invalidateFromMutationAndAwait.mockRejectedValueOnce(new Error('refresh failed'));

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            refreshScmData: vi.fn(async () => {}),
            loadCommitHistory: vi.fn(async () => {}),
            scmCommitStrategy: 'atomic',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
        } as any);

        await act(async () => {
            await hook.getCurrent().createCommit();
        });

        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('a.txt');
        expect(storage.getState().getSessionProjectScmCommitSelectionPaths(sessionId)).toEqual(['a.txt']);
        expect(modalAlert).toHaveBeenCalledTimes(1);

        act(() => {
            hook.unmount();
        });
    });

    it('surfaces partial commit success when backend returns commitSha on failure and preserves selection', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-atomic-selection-partial-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\n');
        git(workspace, ['add', 'a.txt', 'b.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base-a\nchanged-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\nchanged-b\n');

        const sessionId = 'session-hook-atomic-selection-partial';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        const gitHarness = createGitSessionRpcHarness(workspace);
        const createdCommitSha = '1234abcd5678efgh';
        mockSessionRPC.mockImplementation(async (rpcSessionId: string, method: string, request: unknown) => {
            if (method === RPC_METHODS.SCM_COMMIT_CREATE) {
                return {
                    success: false,
                    errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_FAILED,
                    error: 'failed to synchronize live index from isolated index',
                    commitSha: createdCommitSha,
                };
            }
            return gitHarness(rpcSessionId, method, request);
        });

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        storage.getState().markSessionProjectScmCommitSelectionPaths(sessionId, ['a.txt']);

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            refreshScmData: vi.fn(async () => {}),
            loadCommitHistory: vi.fn(async () => {}),
            scmCommitStrategy: 'atomic',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
        } as any);

        await act(async () => {
            await hook.getCurrent().createCommit();
        });

        expect(modalAlert).toHaveBeenCalledTimes(1);
        expect(String(modalAlert.mock.calls[0]?.[1] ?? '')).toContain('created');
        expect(String(modalAlert.mock.calls[0]?.[1] ?? '')).toContain(createdCommitSha.slice(0, 12));
        expect(storage.getState().getSessionProjectScmCommitSelectionPaths(sessionId)).toEqual(['a.txt']);

        const operationLog = storage.getState().getSessionProjectScmOperationLog(sessionId);
        const lastCommitOperation = operationLog.filter((entry) => entry.operation === 'commit').at(-1);
        expect(lastCommitOperation?.status).toBe('failed');
        expect(lastCommitOperation?.detail).toContain(createdCommitSha.slice(0, 12));

        act(() => {
            hook.unmount();
        });
    });

    it('creates an atomic commit from virtual line-selection patches', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-atomic-patch-selection-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nline-one\nline-two\n');

        const sessionId = 'session-hook-atomic-patch-selection';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        storage.getState().upsertSessionProjectScmCommitSelectionPatch(sessionId, {
            path: 'a.txt',
            patch: [
                'diff --git a/a.txt b/a.txt',
                'index df967b9..9f0e218 100644',
                '--- a/a.txt',
                '+++ b/a.txt',
                '@@ -1 +1,2 @@',
                ' base',
                '+line-one',
                '',
            ].join('\n'),
        });

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            refreshScmData: vi.fn(async () => {}),
            loadCommitHistory: vi.fn(async () => {}),
            scmCommitStrategy: 'atomic',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
        } as any);

        await act(async () => {
            await hook.getCurrent().createCommit();
        });

        const commitCall = mockSessionRPC.mock.calls.find((call) => call[1] === RPC_METHODS.SCM_COMMIT_CREATE);
        expect(commitCall?.[2]?.patches?.length).toBe(1);
        expect(commitCall?.[2]?.patches?.[0]?.path).toBe('a.txt');
        expect(git(workspace, ['show', '--pretty=', 'HEAD'])).toContain('+line-one');
        expect(git(workspace, ['show', '--pretty=', 'HEAD'])).not.toContain('+line-two');
        expect(storage.getState().getSessionProjectScmCommitSelectionPatches(sessionId)).toEqual([]);

        act(() => {
            hook.unmount();
        });
    });

    it('creates atomic patch commit without consuming unrelated pre-staged repository state', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-atomic-patch-prestaged-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\n');
        git(workspace, ['add', 'a.txt', 'b.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nline-one\nline-two\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\nline-b\n');
        git(workspace, ['add', 'b.txt']);

        const sessionId = 'session-hook-atomic-patch-selection-prestaged';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        storage.getState().upsertSessionProjectScmCommitSelectionPatch(sessionId, {
            path: 'a.txt',
            patch: [
                'diff --git a/a.txt b/a.txt',
                'index df967b9..9f0e218 100644',
                '--- a/a.txt',
                '+++ b/a.txt',
                '@@ -1 +1,2 @@',
                ' base',
                '+line-one',
                '',
            ].join('\n'),
        });

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            refreshScmData: vi.fn(async () => {}),
            loadCommitHistory: vi.fn(async () => {}),
            scmCommitStrategy: 'atomic',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
        } as any);

        await act(async () => {
            await hook.getCurrent().createCommit();
        });

        expect(git(workspace, ['show', '--pretty=', '--name-only', 'HEAD'])).toBe('a.txt');
        expect(git(workspace, ['show', '--pretty=', 'HEAD'])).toContain('+line-one');
        expect(git(workspace, ['show', '--pretty=', 'HEAD'])).not.toContain('+line-two');
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('b.txt');

        act(() => {
            hook.unmount();
        });
    });

    it('fetches remote updates and refreshes repository data', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-hook-fetch-remote-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-fetch-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);

        const other = mkdtempSync(join(tmpdir(), 'happier-ui-hook-fetch-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'other@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'remote.txt'), 'remote\n');
        git(other, ['add', 'remote.txt']);
        git(other, ['commit', '-m', 'remote update']);
        git(other, ['push', 'origin', branch]);
        const remoteHead = git(other, ['rev-parse', 'HEAD']);

        const sessionId = 'session-hook-2';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const refreshScmData = vi.fn(async () => {});
        const loadCommitHistory = vi.fn(async () => {});

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            scmCommitStrategy: 'git_staging',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
            refreshScmData,
            loadCommitHistory,
        });

        await act(async () => {
            await hook.getCurrent().runRemoteOperation('fetch');
        });

        expect(git(workspace, ['rev-parse', `origin/${branch}`])).toBe(remoteHead);
        expect(refreshScmData).toHaveBeenCalledTimes(1);
        expect(loadCommitHistory).not.toHaveBeenCalled();
        expect(invalidateFromMutationAndAwait).not.toHaveBeenCalled();
        expect(modalConfirm).not.toHaveBeenCalled();
        expect(modalAlert).not.toHaveBeenCalled();

        const operationLog = storage.getState().getSessionProjectScmOperationLog(sessionId);
        expect(operationLog.some((entry) => entry.operation === 'fetch' && entry.status === 'success')).toBe(true);

        act(() => {
            hook.unmount();
        });
    });

    it('offers fetch after non-fast-forward push rejection', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-hook-push-rejected-remote-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-push-rejected-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'base.txt'), 'base\n');
        git(workspace, ['add', 'base.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);

        writeFileSync(join(workspace, 'local.txt'), 'local\n');
        git(workspace, ['add', 'local.txt']);
        git(workspace, ['commit', '-m', 'local change']);

        const other = mkdtempSync(join(tmpdir(), 'happier-ui-hook-push-rejected-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'other@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'remote.txt'), 'remote\n');
        git(other, ['add', 'remote.txt']);
        git(other, ['commit', '-m', 'remote change']);
        git(other, ['push', 'origin', branch]);
        const remoteHead = git(other, ['rev-parse', 'HEAD']);

        const sessionId = 'session-hook-3';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const refreshScmData = vi.fn(async () => {});
        const loadCommitHistory = vi.fn(async () => {});

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            scmCommitStrategy: 'git_staging',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
            refreshScmData,
            loadCommitHistory,
        });

        await act(async () => {
            await hook.getCurrent().runRemoteOperation('push');
        });

        expect(modalConfirm).toHaveBeenCalledTimes(2);
        expect(refreshScmData).toHaveBeenCalledTimes(1);
        expect(loadCommitHistory).not.toHaveBeenCalled();
        expect(invalidateFromMutationAndAwait).not.toHaveBeenCalled();
        expect(git(workspace, ['rev-parse', `origin/${branch}`])).toBe(remoteHead);

        const operationLog = storage.getState().getSessionProjectScmOperationLog(sessionId);
        expect(operationLog.some((entry) => entry.operation === 'push' && entry.status === 'failed')).toBe(true);
        expect(operationLog.some((entry) => entry.operation === 'fetch' && entry.status === 'success')).toBe(true);

        act(() => {
            hook.unmount();
        });
    });

    it('skips pull/push confirmation when remote confirm policy is never', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-hook-confirm-never-remote-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-confirm-never-workspace-'));
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

        const sessionId = 'session-hook-confirm-never';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            scmCommitStrategy: 'git_staging',
            scmRemoteConfirmPolicy: 'never',
            scmPushRejectPolicy: 'prompt_fetch',
            refreshScmData: vi.fn(async () => {}),
            loadCommitHistory: vi.fn(async () => {}),
        });

        await act(async () => {
            await hook.getCurrent().runRemoteOperation('push');
        });

        expect(modalConfirm).not.toHaveBeenCalled();

        act(() => {
            hook.unmount();
        });
    });

    it('auto-fetches after push rejection when push reject policy is auto_fetch', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-hook-auto-fetch-remote-'));
        initBareRemote(remote);

        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-auto-fetch-workspace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'base.txt'), 'base\n');
        git(workspace, ['add', 'base.txt']);
        git(workspace, ['commit', '-m', 'base']);
        git(workspace, ['remote', 'add', 'origin', remote]);
        const branch = git(workspace, ['rev-parse', '--abbrev-ref', 'HEAD']);
        git(workspace, ['push', '-u', 'origin', branch]);

        writeFileSync(join(workspace, 'local.txt'), 'local\n');
        git(workspace, ['add', 'local.txt']);
        git(workspace, ['commit', '-m', 'local change']);

        const other = mkdtempSync(join(tmpdir(), 'happier-ui-hook-auto-fetch-other-'));
        git(other, ['clone', remote, '.']);
        git(other, ['config', 'user.email', 'other@example.com']);
        git(other, ['config', 'user.name', 'Other User']);
        writeFileSync(join(other, 'remote.txt'), 'remote\n');
        git(other, ['add', 'remote.txt']);
        git(other, ['commit', '-m', 'remote change']);
        git(other, ['push', 'origin', branch]);
        const remoteHead = git(other, ['rev-parse', 'HEAD']);

        const sessionId = 'session-hook-auto-fetch';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const refreshScmData = vi.fn(async () => {});
        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            scmCommitStrategy: 'git_staging',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'auto_fetch',
            refreshScmData,
            loadCommitHistory: vi.fn(async () => {}),
        });

        await act(async () => {
            await hook.getCurrent().runRemoteOperation('push');
        });

        expect(modalConfirm).toHaveBeenCalledTimes(1);
        expect(refreshScmData).toHaveBeenCalledTimes(1);
        expect(git(workspace, ['rev-parse', `origin/${branch}`])).toBe(remoteHead);

        act(() => {
            hook.unmount();
        });
    });

    it('creates a commit through sapling backend and refreshes commit history', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-sapling-workspace-'));
        initSaplingRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');

        const sessionId = 'session-hook-sapling-1';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createSaplingSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected sapling snapshot');
        }

        const refreshScmData = vi.fn(async () => {});
        const loadCommitHistory = vi.fn(async () => {});

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            scmCommitStrategy: 'git_staging',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
            refreshScmData,
            loadCommitHistory,
        });

        await act(async () => {
            await hook.getCurrent().createCommit();
        });

        expect(runSapling(workspace, ['status', '--root-relative'])).toBe('');
        expect(invalidateFromMutationAndAwait).toHaveBeenCalledTimes(1);
        expect(loadCommitHistory).toHaveBeenCalledWith({ reset: true });
        expect(refreshScmData).not.toHaveBeenCalled();
        expect(modalAlert).not.toHaveBeenCalled();

        const operationLog = storage.getState().getSessionProjectScmOperationLog(sessionId);
        expect(operationLog.some((entry) => entry.operation === 'commit' && entry.status === 'success')).toBe(true);

        act(() => {
            hook.unmount();
        });
    });

    it('creates a path-scoped atomic commit through sapling backend when selection paths exist', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-sapling-selection-workspace-'));
        initSaplingRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\n');
        runSapling(workspace, ['commit', '-A', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base-a\nnext-a\n');
        writeFileSync(join(workspace, 'b.txt'), 'base-b\nnext-b\n');

        const sessionId = 'session-hook-sapling-selection';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createSaplingSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected sapling snapshot');
        }

        storage.getState().markSessionProjectScmCommitSelectionPaths(sessionId, ['a.txt']);

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            scmCommitStrategy: 'atomic',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
            refreshScmData: vi.fn(async () => {}),
            loadCommitHistory: vi.fn(async () => {}),
        });

        await act(async () => {
            await hook.getCurrent().createCommit();
        });

        const commitCall = mockSessionRPC.mock.calls.find((call) => call[1] === RPC_METHODS.SCM_COMMIT_CREATE);
        expect(commitCall?.[2]?.scope).toEqual({ kind: 'paths', include: ['a.txt'] });
        expect(runSapling(workspace, ['status', '--root-relative'])).toContain('M b.txt');
        expect(storage.getState().getSessionProjectScmCommitSelectionPaths(sessionId)).toEqual([]);

        act(() => {
            hook.unmount();
        });
    });

    it('creates a directory-scoped atomic commit through sapling backend when selection paths contain folders', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-sapling-dir-selection-workspace-'));
        initSaplingRepo(workspace);
        mkdirSync(join(workspace, 'src'), { recursive: true });
        mkdirSync(join(workspace, 'docs'), { recursive: true });
        writeFileSync(join(workspace, 'src', 'b.txt'), 'base\n');
        writeFileSync(join(workspace, 'docs', 'c.txt'), 'base\n');
        runSapling(workspace, ['commit', '-A', '-m', 'base']);
        writeFileSync(join(workspace, 'src', 'b.txt'), 'base\nnext-src\n');
        writeFileSync(join(workspace, 'docs', 'c.txt'), 'base\nnext-docs\n');

        const sessionId = 'session-hook-sapling-dir-selection';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createSaplingSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected sapling snapshot');
        }

        storage.getState().markSessionProjectScmCommitSelectionPaths(sessionId, ['src']);

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            scmCommitStrategy: 'atomic',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
            refreshScmData: vi.fn(async () => {}),
            loadCommitHistory: vi.fn(async () => {}),
        });

        await act(async () => {
            await hook.getCurrent().createCommit();
        });

        expect(runSapling(workspace, ['status', '--root-relative'])).toContain('M docs/c.txt');
        expect(storage.getState().getSessionProjectScmCommitSelectionPaths(sessionId)).toEqual([]);

        act(() => {
            hook.unmount();
        });
    });

    it('does not infer sapling push branch from active commit hash and surfaces upstream-required error', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-hook-sapling-push-'));
        initSaplingRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'hello\n');
        runSapling(workspace, ['commit', '-A', '-m', 'init']);

        const sessionId = 'session-hook-sapling-2';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createSaplingSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected sapling snapshot');
        }

        const refreshScmData = vi.fn(async () => {});
        const loadCommitHistory = vi.fn(async () => {});

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            scmCommitStrategy: 'git_staging',
            scmRemoteConfirmPolicy: 'always',
            scmPushRejectPolicy: 'prompt_fetch',
            refreshScmData,
            loadCommitHistory,
        });

        await act(async () => {
            await hook.getCurrent().runRemoteOperation('push');
        });

        expect(modalAlert).toHaveBeenCalledTimes(1);
        expect(modalAlert.mock.calls[0]?.[1]).toBe('Set a tracking target before pull or push.');
        expect(modalConfirm).not.toHaveBeenCalled();
        expect(refreshScmData).not.toHaveBeenCalled();
        expect(loadCommitHistory).not.toHaveBeenCalled();

        const operationLog = storage.getState().getSessionProjectScmOperationLog(sessionId);
        expect(operationLog.some((entry) => entry.operation === 'push')).toBe(false);

        act(() => {
            hook.unmount();
        });
    });
});
