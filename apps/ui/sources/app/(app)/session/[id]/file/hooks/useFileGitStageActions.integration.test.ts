import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const {
    mockSessionRPC,
    modalAlert,
    invalidateFromMutationAndAwait,
    trackingCapture,
} = vi.hoisted(() => ({
    mockSessionRPC: vi.fn(),
    modalAlert: vi.fn(),
    invalidateFromMutationAndAwait: vi.fn(async () => {}),
    trackingCapture: vi.fn(),
}));

vi.mock('@/sync/apiSocket', () => ({
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
        confirm: vi.fn(),
        prompt: vi.fn(),
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
import { projectManager } from '@/sync/projectManager';
import { storage } from '@/sync/storage';
import { createGitSessionRpcHarness, git, initRepo } from '@/sync/ops/__tests__/gitRepoHarness';
import { useFileGitStageActions } from './useFileGitStageActions';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = storage.getState();

type HookProps = Parameters<typeof useFileGitStageActions>[0];

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
    let current: ReturnType<typeof useFileGitStageActions> | null = null;

    function Probe() {
        current = useFileGitStageActions(props);
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

function lineIndexByContent(diff: string, expectedLine: string): number {
    const index = diff.split('\n').findIndex((line) => line === expectedLine);
    if (index < 0) {
        throw new Error(`line not found in diff: ${expectedLine}`);
    }
    return index;
}

describe('useFileGitStageActions integration', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
        projectManager.clear();

        mockSessionRPC.mockReset();
        modalAlert.mockReset();
        invalidateFromMutationAndAwait.mockReset();
        trackingCapture.mockReset();
    });

    it('stages and unstages a full file through real git operations', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-file-stage-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nnext\n');

        const sessionId = 'session-file-stage-1';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionGitStatusSnapshot(sessionId, { cwd: workspace });
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const refreshAll = vi.fn(async () => {});
        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            filePath: 'a.txt',
            gitSnapshot: snapshotResponse.snapshot,
            gitWriteEnabled: true,
            diffMode: 'unstaged',
            diffContent: git(workspace, ['diff', '--', 'a.txt']),
            lineSelectionEnabled: false,
            selectedLineIndexes: new Set<number>(),
            refreshAll,
            setSelectedLineIndexes: vi.fn() as any,
        });

        await act(async () => {
            await hook.getCurrent().handleStage(true);
        });

        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('a.txt');

        await act(async () => {
            await hook.getCurrent().handleStage(false);
        });

        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('');
        expect(git(workspace, ['diff', '--name-only'])).toBe('a.txt');
        expect(invalidateFromMutationAndAwait).toHaveBeenCalledTimes(2);
        expect(refreshAll).toHaveBeenCalledTimes(2);
        expect(modalAlert).not.toHaveBeenCalled();

        const operationLog = storage.getState().getSessionProjectGitOperationLog(sessionId);
        expect(operationLog.some((entry) => entry.operation === 'stage' && entry.status === 'success')).toBe(true);
        expect(operationLog.some((entry) => entry.operation === 'unstage' && entry.status === 'success')).toBe(true);

        act(() => {
            hook.unmount();
        });
    });

    it('stages selected lines only and keeps the remaining diff unstaged', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-file-line-stage-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nline-one\nline-two\n');

        const diff = git(workspace, ['diff', '--', 'a.txt']);
        const selectedIndex = lineIndexByContent(diff, '+line-one');

        const sessionId = 'session-file-stage-2';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionGitStatusSnapshot(sessionId, { cwd: workspace });
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const refreshAll = vi.fn(async () => {});
        const setSelectedLineIndexes = vi.fn();

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            filePath: 'a.txt',
            gitSnapshot: snapshotResponse.snapshot,
            gitWriteEnabled: true,
            diffMode: 'unstaged',
            diffContent: diff,
            lineSelectionEnabled: true,
            selectedLineIndexes: new Set([selectedIndex]),
            refreshAll,
            setSelectedLineIndexes: setSelectedLineIndexes as any,
        });

        await act(async () => {
            await hook.getCurrent().applySelectedLines();
        });

        const stagedDiff = git(workspace, ['diff', '--cached', '--', 'a.txt']);
        const unstagedDiff = git(workspace, ['diff', '--', 'a.txt']);

        expect(stagedDiff).toContain('+line-one');
        expect(stagedDiff).not.toContain('+line-two');
        expect(unstagedDiff).toContain('+line-two');
        expect(setSelectedLineIndexes).toHaveBeenCalledWith(new Set());
        expect(invalidateFromMutationAndAwait).toHaveBeenCalledTimes(1);
        expect(refreshAll).toHaveBeenCalledTimes(1);
        expect(modalAlert).not.toHaveBeenCalled();

        act(() => {
            hook.unmount();
        });
    });

    it('unstages selected lines from the staged diff only', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-file-line-unstage-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nline-one\nline-two\n');
        git(workspace, ['add', 'a.txt']);

        const stagedDiff = git(workspace, ['diff', '--cached', '--', 'a.txt']);
        const selectedIndex = lineIndexByContent(stagedDiff, '+line-one');

        const sessionId = 'session-file-stage-3';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionGitStatusSnapshot(sessionId, { cwd: workspace });
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const refreshAll = vi.fn(async () => {});

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            filePath: 'a.txt',
            gitSnapshot: snapshotResponse.snapshot,
            gitWriteEnabled: true,
            diffMode: 'staged',
            diffContent: stagedDiff,
            lineSelectionEnabled: true,
            selectedLineIndexes: new Set([selectedIndex]),
            refreshAll,
            setSelectedLineIndexes: vi.fn() as any,
        });

        await act(async () => {
            await hook.getCurrent().applySelectedLines();
        });

        const nextStagedDiff = git(workspace, ['diff', '--cached', '--', 'a.txt']);
        const nextUnstagedDiff = git(workspace, ['diff', '--', 'a.txt']);

        expect(nextStagedDiff).toContain('+line-two');
        expect(nextStagedDiff).not.toContain('+line-one');
        expect(nextUnstagedDiff).toContain('+line-one');
        expect(invalidateFromMutationAndAwait).toHaveBeenCalledTimes(1);
        expect(refreshAll).toHaveBeenCalledTimes(1);
        expect(modalAlert).not.toHaveBeenCalled();

        act(() => {
            hook.unmount();
        });
    });
});
