import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

vi.mock('@/sync/git/gitStatusSync', () => ({
    gitStatusSync: {
        invalidateFromMutationAndAwait,
    },
}));

vi.mock('@/track', () => ({
    tracking: {
        capture: trackingCapture,
    },
}));

import { sessionGitStatusSnapshot } from '@/sync/ops';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { storage } from '@/sync/domains/state/storage';
import { createGitSessionRpcHarness, git, initRepo } from '@/sync/ops/__tests__/gitRepoHarness';
import { useFilesGitOperations } from './useFilesGitOperations';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = storage.getState();

type HookProps = Parameters<typeof useFilesGitOperations>[0];

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
    let current: ReturnType<typeof useFilesGitOperations> | null = null;

    function Probe() {
        current = useFilesGitOperations(props);
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

describe('useFilesGitOperations integration', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        projectManager.clear();

        mockSessionRPC.mockReset();
        modalAlert.mockReset();
        modalConfirm.mockReset();
        modalPrompt.mockReset();
        invalidateFromMutationAndAwait.mockReset();
        trackingCapture.mockReset();

        modalConfirm.mockResolvedValue(true);
        modalPrompt.mockResolvedValue('feat: hook integration commit');
    });

    it('creates a commit then pushes successfully against a real remote', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-hook-remote-'));
        git(remote, ['init', '--bare']);

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

        const snapshotResponse = await sessionGitStatusSnapshot(sessionId, { cwd: workspace });
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const refreshGitData = vi.fn(async () => {});
        const loadCommitHistory = vi.fn(async () => {});

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            gitSnapshot: snapshotResponse.snapshot,
            gitWriteEnabled: true,
            refreshGitData,
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
        expect(refreshGitData).not.toHaveBeenCalled();
        expect(modalConfirm).toHaveBeenCalledTimes(1);
        expect(modalAlert).not.toHaveBeenCalled();

        const operationLog = storage.getState().getSessionProjectGitOperationLog(sessionId);
        expect(operationLog.some((entry) => entry.operation === 'commit' && entry.status === 'success')).toBe(true);
        expect(operationLog.some((entry) => entry.operation === 'push' && entry.status === 'success')).toBe(true);

        act(() => {
            hook.unmount();
        });
    });

    it('fetches remote updates and refreshes repository data', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-hook-fetch-remote-'));
        git(remote, ['init', '--bare']);

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

        const snapshotResponse = await sessionGitStatusSnapshot(sessionId, { cwd: workspace });
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const refreshGitData = vi.fn(async () => {});
        const loadCommitHistory = vi.fn(async () => {});

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            gitSnapshot: snapshotResponse.snapshot,
            gitWriteEnabled: true,
            refreshGitData,
            loadCommitHistory,
        });

        await act(async () => {
            await hook.getCurrent().runRemoteOperation('fetch');
        });

        expect(git(workspace, ['rev-parse', `origin/${branch}`])).toBe(remoteHead);
        expect(refreshGitData).toHaveBeenCalledTimes(1);
        expect(loadCommitHistory).not.toHaveBeenCalled();
        expect(invalidateFromMutationAndAwait).not.toHaveBeenCalled();
        expect(modalConfirm).not.toHaveBeenCalled();
        expect(modalAlert).not.toHaveBeenCalled();

        const operationLog = storage.getState().getSessionProjectGitOperationLog(sessionId);
        expect(operationLog.some((entry) => entry.operation === 'fetch' && entry.status === 'success')).toBe(true);

        act(() => {
            hook.unmount();
        });
    });

    it('offers fetch after non-fast-forward push rejection', async () => {
        const remote = mkdtempSync(join(tmpdir(), 'happier-ui-hook-push-rejected-remote-'));
        git(remote, ['init', '--bare']);

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

        const snapshotResponse = await sessionGitStatusSnapshot(sessionId, { cwd: workspace });
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const refreshGitData = vi.fn(async () => {});
        const loadCommitHistory = vi.fn(async () => {});

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            gitSnapshot: snapshotResponse.snapshot,
            gitWriteEnabled: true,
            refreshGitData,
            loadCommitHistory,
        });

        await act(async () => {
            await hook.getCurrent().runRemoteOperation('push');
        });

        expect(modalConfirm).toHaveBeenCalledTimes(2);
        expect(refreshGitData).toHaveBeenCalledTimes(1);
        expect(loadCommitHistory).not.toHaveBeenCalled();
        expect(invalidateFromMutationAndAwait).not.toHaveBeenCalled();
        expect(git(workspace, ['rev-parse', `origin/${branch}`])).toBe(remoteHead);

        const operationLog = storage.getState().getSessionProjectGitOperationLog(sessionId);
        expect(operationLog.some((entry) => entry.operation === 'push' && entry.status === 'failed')).toBe(true);
        expect(operationLog.some((entry) => entry.operation === 'fetch' && entry.status === 'success')).toBe(true);

        act(() => {
            hook.unmount();
        });
    });
});
