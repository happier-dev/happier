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
import { useGitCommitHistory } from './useGitCommitHistory';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type HookProps = Parameters<typeof useGitCommitHistory>[0];

function mountHook(props: HookProps) {
    let current: ReturnType<typeof useGitCommitHistory> | null = null;

    function Probe() {
        current = useGitCommitHistory(props);
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

describe('useGitCommitHistory integration', () => {
    beforeEach(() => {
        mockSessionRPC.mockReset();
    });

    it('paginates real git history and supports reset reload', async () => {
        const workspace = createRepoWithCommits(25);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const hook = mountHook({
            sessionId: 'session-history-1',
            gitWriteEnabled: true,
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

    it('clears history when git write operations are disabled', async () => {
        const workspace = createRepoWithCommits(3);
        mockSessionRPC.mockImplementation(createGitSessionRpcHarness(workspace));

        const hook = mountHook({
            sessionId: 'session-history-2',
            gitWriteEnabled: false,
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
});
