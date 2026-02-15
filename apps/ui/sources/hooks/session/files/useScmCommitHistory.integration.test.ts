import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { mockSessionRPC } = vi.hoisted(() => ({
    mockSessionRPC: vi.fn(),
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

import { createGitSessionRpcHarness, git, initRepo } from '@/sync/ops/__tests__/gitRepoHarness';
import { createSaplingSessionRpcHarness, initSaplingRepo, runSapling } from '@/sync/ops/__tests__/saplingRepoHarness';
import { useScmCommitHistory } from './useScmCommitHistory';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type HookProps = Parameters<typeof useScmCommitHistory>[0];

function mountHook(props: HookProps) {
    let current: ReturnType<typeof useScmCommitHistory> | null = null;

    function Probe() {
        current = useScmCommitHistory(props);
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

function createRepoWithCommits(totalCommits: number): string {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-history-hook-'));
    initRepo(workspace);
    for (let index = 1; index <= totalCommits; index += 1) {
        const path = join(workspace, `file-${index}.txt`);
        writeFileSync(path, `commit-${index}\n`);
        git(workspace, ['add', `file-${index}.txt`]);
        git(workspace, ['commit', '-m', `commit-${index}`]);
    }
    return workspace;
}

function createSaplingRepoWithCommits(totalCommits: number): string {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-ui-history-hook-sapling-'));
    initSaplingRepo(workspace);
    for (let index = 1; index <= totalCommits; index += 1) {
        const path = join(workspace, `file-${index}.txt`);
        writeFileSync(path, `commit-${index}\n`);
        runSapling(workspace, ['commit', '-A', '-m', `commit-${index}`]);
    }
    return workspace;
}

describe('useScmCommitHistory integration', () => {
    beforeEach(() => {
        mockSessionRPC.mockReset();
    });

    it('paginates real git history and supports reset reload', async () => {
        const workspace = createRepoWithCommits(25);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const hook = mountHook({
            sessionId: 'session-history-1',
            readLogEnabled: true,
            sessionPath: workspace,
        });

        await act(async () => {
            await hook.getCurrent().loadCommitHistory({ reset: true });
        });

        const firstPage = hook.getCurrent();
        expect(firstPage.historyEntries).toHaveLength(20);
        expect(firstPage.historyHasMore).toBe(true);

        await act(async () => {
            await hook.getCurrent().loadCommitHistory();
        });

        const secondPage = hook.getCurrent();
        expect(secondPage.historyEntries).toHaveLength(25);
        expect(secondPage.historyHasMore).toBe(false);

        const uniqueShas = new Set(secondPage.historyEntries.map((entry) => entry.sha));
        expect(uniqueShas.size).toBe(secondPage.historyEntries.length);

        await act(async () => {
            await hook.getCurrent().loadCommitHistory({ reset: true });
        });

        const resetPage = hook.getCurrent();
        expect(resetPage.historyEntries).toHaveLength(20);
        expect(resetPage.historyHasMore).toBe(true);

        act(() => {
            hook.unmount();
        });
    });

    it('stops pagination when backend ignores skip (legacy daemon)', async () => {
        const workspace = createRepoWithCommits(25);
        const harness = createGitSessionRpcHarness(workspace);

        // Simulate an older daemon that ignores `skip` and always returns the first page.
        mockSessionRPC.mockImplementation(async (sessionId: string, method: string, request: any) => {
            if (method === 'scm.log.list' && request && typeof request === 'object') {
                return harness(sessionId, method, { ...request, skip: 0 });
            }
            return harness(sessionId, method, request);
        });

        const hook = mountHook({
            sessionId: 'session-history-legacy-skip',
            readLogEnabled: true,
            sessionPath: workspace,
        });

        await act(async () => {
            await hook.getCurrent().loadCommitHistory({ reset: true });
        });

        const firstPage = hook.getCurrent();
        expect(firstPage.historyEntries).toHaveLength(20);
        expect(firstPage.historyHasMore).toBe(true);

        await act(async () => {
            await hook.getCurrent().loadCommitHistory();
        });

        const secondPage = hook.getCurrent();
        // Still the first page because pagination was ignored.
        expect(secondPage.historyEntries).toHaveLength(20);
        // The hook should recognize that pagination made no progress and stop offering "load more".
        expect(secondPage.historyHasMore).toBe(false);

        act(() => {
            hook.unmount();
        });
    });

    it('clears history when log reading is disabled by backend capabilities', async () => {
        const workspace = createRepoWithCommits(3);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const hook = mountHook({
            sessionId: 'session-history-2',
            readLogEnabled: false,
            sessionPath: workspace,
        });

        await act(async () => {
            await hook.getCurrent().loadCommitHistory({ reset: true });
        });

        const current = hook.getCurrent();
        expect(current.historyEntries).toEqual([]);
        expect(current.historyHasMore).toBe(false);

        act(() => {
            hook.unmount();
        });
    });

    it('loads sapling history entries through session scm log RPC', async () => {
        const workspace = createSaplingRepoWithCommits(3);
        mockSessionRPC.mockImplementation(createSaplingSessionRpcHarness(workspace));

        const hook = mountHook({
            sessionId: 'session-history-sapling-1',
            readLogEnabled: true,
            sessionPath: workspace,
        });

        await act(async () => {
            await hook.getCurrent().loadCommitHistory({ reset: true });
        });

        const current = hook.getCurrent();
        expect(current.historyEntries.length).toBeGreaterThan(0);
        expect(current.historyEntries[0]?.subject).toBe('commit-3');
        expect(current.historyHasMore).toBe(false);

        act(() => {
            hook.unmount();
        });
    });
});
