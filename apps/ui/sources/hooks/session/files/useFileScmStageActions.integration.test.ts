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
	    mockMachineRPC,
	} = vi.hoisted(() => ({
	    mockSessionRPC: vi.fn(),
	    modalAlert: vi.fn(),
	    invalidateFromMutationAndAwait: vi.fn(async () => {}),
	    trackingCapture: vi.fn(),
	    mockMachineRPC: vi.fn(async () => {
	        const err = new Error('RPC method not available');
	        (err as Error & { rpcErrorCode?: string }).rpcErrorCode = 'RPC_METHOD_NOT_AVAILABLE';
	        throw err;
	    }),
	}));

	vi.mock('@/sync/api/session/apiSocket', () => ({
	    apiSocket: {
	        sessionRPC: mockSessionRPC,
	        machineRPC: mockMachineRPC,
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
import { createGitSessionRpcHarness, git, initRepo } from '@/sync/ops/__tests__/gitRepoHarness';
import { normalizeWorkingSnapshotForUi } from '@/scm/scmRepositoryService';
import { useFileScmStageActions } from './useFileScmStageActions';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const initialStorageState = storage.getState();

type HookProps = Parameters<typeof useFileScmStageActions>[0];

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
    let current: ReturnType<typeof useFileScmStageActions> | null = null;

    function Probe() {
        current = useFileScmStageActions(props);
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

function selectionKeyByContent(diff: string, expectedLine: string): string {
    const hunkHeader = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/;
    let oldLine = 0;
    let newLine = 0;

    for (const line of diff.split('\n')) {
        const headerMatch = hunkHeader.exec(line);
        if (headerMatch) {
            oldLine = Number(headerMatch[1] ?? 0);
            newLine = Number(headerMatch[2] ?? 0);
            continue;
        }

        if (line === expectedLine) {
            if (line.startsWith('-') && !line.startsWith('---')) return `deletions:${oldLine}`;
            if (line.startsWith('+') && !line.startsWith('+++')) return `additions:${newLine}`;
            throw new Error(`expected a diff content line (+/-), got: ${expectedLine}`);
        }

        if (line.startsWith(' ')) {
            oldLine += 1;
            newLine += 1;
            continue;
        }
        if (line.startsWith('-') && !line.startsWith('---')) {
            oldLine += 1;
            continue;
        }
        if (line.startsWith('+') && !line.startsWith('+++')) {
            newLine += 1;
            continue;
        }
    }

    throw new Error(`line not found in diff: ${expectedLine}`);
}

describe('useFileScmStageActions integration', () => {
    beforeEach(() => {
        storage.setState(initialStorageState, true);
	        projectManager.clear();

	        mockSessionRPC.mockReset();
	        mockMachineRPC.mockReset();
	        modalAlert.mockReset();
	        invalidateFromMutationAndAwait.mockReset();
	        trackingCapture.mockReset();

	        mockMachineRPC.mockImplementation(async () => {
	            const err = new Error('RPC method not available');
	            (err as Error & { rpcErrorCode?: string }).rpcErrorCode = 'RPC_METHOD_NOT_AVAILABLE';
	            throw err;
	        });
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

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const refreshAll = vi.fn(async () => {});
        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            filePath: 'a.txt',
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            scmCommitStrategy: 'git_staging',
            includeExcludeEnabled: true,
            diffMode: 'pending',
            diffContent: git(workspace, ['diff', '--', 'a.txt']),
            lineSelectionEnabled: false,
            selectedLineKeys: new Set<string>(),
            refreshAll,
            setSelectedLineKeys: vi.fn() as any,
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

        const operationLog = storage.getState().getSessionProjectScmOperationLog(sessionId);
        expect(operationLog.some((entry) => entry.operation === 'stage' && entry.status === 'success')).toBe(true);
        expect(operationLog.some((entry) => entry.operation === 'unstage' && entry.status === 'success')).toBe(true);

        act(() => {
            hook.unmount();
        });
    });

    it('tracks virtual commit selection paths when commit strategy is atomic', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-file-stage-atomic-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nnext\n');

        const sessionId = 'session-file-stage-atomic';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const refreshAll = vi.fn(async () => {});
        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            filePath: 'a.txt',
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            includeExcludeEnabled: true,
            diffMode: 'pending',
            diffContent: git(workspace, ['diff', '--', 'a.txt']),
            lineSelectionEnabled: false,
            selectedLineKeys: new Set<string>(),
            refreshAll,
            setSelectedLineKeys: vi.fn() as any,
            scmCommitStrategy: 'atomic',
        } as any);

        await act(async () => {
            await hook.getCurrent().handleStage(true);
        });

        expect(storage.getState().getSessionProjectScmCommitSelectionPaths(sessionId)).toEqual(['a.txt']);
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('');
        expect(invalidateFromMutationAndAwait).not.toHaveBeenCalled();
        expect(refreshAll).not.toHaveBeenCalled();
        expect(modalAlert).not.toHaveBeenCalled();

        await act(async () => {
            await hook.getCurrent().handleStage(false);
        });

        expect(storage.getState().getSessionProjectScmCommitSelectionPaths(sessionId)).toEqual([]);
        expect(git(workspace, ['diff', '--cached', '--name-only'])).toBe('');
        expect(invalidateFromMutationAndAwait).not.toHaveBeenCalled();
        expect(refreshAll).not.toHaveBeenCalled();

        act(() => {
            hook.unmount();
        });
    });

    it('stores virtual patch selection for atomic line-selected commit', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-file-line-selection-atomic-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nline-one\nline-two\n');

        const diff = git(workspace, ['diff', '--', 'a.txt']);
        const selectedKey = selectionKeyByContent(diff, '+line-one');

        const sessionId = 'session-file-stage-atomic-lines';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const setSelectedLineKeys = vi.fn();
        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            filePath: 'a.txt',
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            scmCommitStrategy: 'atomic',
            includeExcludeEnabled: false,
            diffMode: 'pending',
            diffContent: diff,
            lineSelectionEnabled: true,
            selectedLineKeys: new Set<string>([selectedKey]),
            refreshAll: vi.fn(async () => {}),
            setSelectedLineKeys: setSelectedLineKeys as any,
        });

        await act(async () => {
            await hook.getCurrent().applySelectedLines();
        });

        const patches = storage.getState().getSessionProjectScmCommitSelectionPatches(sessionId);
        expect(patches).toHaveLength(1);
        expect(patches[0]?.path).toBe('a.txt');
        expect(patches[0]?.patch).toContain('+line-one');
        expect(patches[0]?.patch).not.toContain('+line-two');
        expect(setSelectedLineKeys).toHaveBeenCalled();
        expect(invalidateFromMutationAndAwait).not.toHaveBeenCalled();

        act(() => {
            hook.unmount();
        });
    });

    it('replaces atomic path selection with patch selection for the same file', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-file-line-selection-atomic-replace-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nline-one\nline-two\n');

        const diff = git(workspace, ['diff', '--', 'a.txt']);
        const selectedKey = selectionKeyByContent(diff, '+line-one');

        const sessionId = 'session-file-stage-atomic-replace';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));
        storage.getState().markSessionProjectScmCommitSelectionPaths(sessionId, ['a.txt']);

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            filePath: 'a.txt',
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            scmCommitStrategy: 'atomic',
            includeExcludeEnabled: false,
            diffMode: 'pending',
            diffContent: diff,
            lineSelectionEnabled: true,
            selectedLineKeys: new Set<string>([selectedKey]),
            refreshAll: vi.fn(async () => {}),
            setSelectedLineKeys: vi.fn() as any,
        });

        await act(async () => {
            await hook.getCurrent().applySelectedLines();
        });

        expect(storage.getState().getSessionProjectScmCommitSelectionPaths(sessionId)).toEqual([]);
        const patches = storage.getState().getSessionProjectScmCommitSelectionPatches(sessionId);
        expect(patches).toHaveLength(1);
        expect(patches[0]?.path).toBe('a.txt');

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
        const selectedKey = selectionKeyByContent(diff, '+line-one');

        const sessionId = 'session-file-stage-2';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const refreshAll = vi.fn(async () => {});
        const setSelectedLineKeys = vi.fn();

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            filePath: 'a.txt',
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            scmCommitStrategy: 'git_staging',
            includeExcludeEnabled: true,
            diffMode: 'pending',
            diffContent: diff,
            lineSelectionEnabled: true,
            selectedLineKeys: new Set<string>([selectedKey]),
            refreshAll,
            setSelectedLineKeys: setSelectedLineKeys as any,
        });

        await act(async () => {
            await hook.getCurrent().applySelectedLines();
        });

        const stagedDiff = git(workspace, ['diff', '--cached', '--', 'a.txt']);
        const unstagedDiff = git(workspace, ['diff', '--', 'a.txt']);

        expect(stagedDiff).toContain('+line-one');
        expect(stagedDiff).not.toContain('+line-two');
        expect(unstagedDiff).toContain('+line-two');
        expect(setSelectedLineKeys).toHaveBeenCalledWith(new Set());
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
        const selectedKey = selectionKeyByContent(stagedDiff, '+line-one');

        const sessionId = 'session-file-stage-3';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const refreshAll = vi.fn(async () => {});

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            filePath: 'a.txt',
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            scmCommitStrategy: 'git_staging',
            includeExcludeEnabled: true,
            diffMode: 'included',
            diffContent: stagedDiff,
            lineSelectionEnabled: true,
            selectedLineKeys: new Set<string>([selectedKey]),
            refreshAll,
            setSelectedLineKeys: vi.fn() as any,
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

    it('unstages selected added replacement lines without requiring paired deletion selection', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-file-line-unstage-added-'));
        initRepo(workspace);
        writeFileSync(join(workspace, 'a.txt'), 'base\nalpha\n');
        git(workspace, ['add', 'a.txt']);
        git(workspace, ['commit', '-m', 'base']);
        writeFileSync(join(workspace, 'a.txt'), 'base\nbeta\n');
        git(workspace, ['add', 'a.txt']);

        const stagedDiff = git(workspace, ['diff', '--cached', '--', 'a.txt']);
        const selectedKey = selectionKeyByContent(stagedDiff, '+beta');

        const sessionId = 'session-file-stage-4';
        storage.getState().applySessions([createSession(sessionId, workspace) as any]);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const snapshotResponse = await sessionScmStatusSnapshot(sessionId, {});
        expect(snapshotResponse.success).toBe(true);
        if (!snapshotResponse.success || !snapshotResponse.snapshot) {
            throw new Error('expected git snapshot');
        }

        const refreshAll = vi.fn(async () => {});

        const hook = mountHook({
            sessionId,
            sessionPath: workspace,
            filePath: 'a.txt',
            scmSnapshot: normalizeWorkingSnapshotForUi(snapshotResponse.snapshot, `local:${workspace}`),
            scmWriteEnabled: true,
            scmCommitStrategy: 'git_staging',
            includeExcludeEnabled: true,
            diffMode: 'included',
            diffContent: stagedDiff,
            lineSelectionEnabled: true,
            selectedLineKeys: new Set<string>([selectedKey]),
            refreshAll,
            setSelectedLineKeys: vi.fn() as any,
        });

        await act(async () => {
            await hook.getCurrent().applySelectedLines();
        });

        const nextStagedDiff = git(workspace, ['diff', '--cached', '--', 'a.txt']);

        expect(nextStagedDiff).toContain('-alpha');
        expect(nextStagedDiff).not.toContain('+beta');
        expect(invalidateFromMutationAndAwait).toHaveBeenCalledTimes(1);
        expect(refreshAll).toHaveBeenCalledTimes(1);
        expect(modalAlert).not.toHaveBeenCalled();

        act(() => {
            hook.unmount();
        });
    });
});
