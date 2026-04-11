import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderHook } from '@/dev/testkit';

const { machineRpcWithServerScopeMock, getStateMock } = vi.hoisted(() => ({
    machineRpcWithServerScopeMock: vi.fn(),
    getStateMock: vi.fn(),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (params: unknown) => machineRpcWithServerScopeMock(params),
}));

vi.mock('@/sync/domains/state/storage', async () => {
    const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleStub({
        storage: {
            getState: getStateMock,
        },
    });
});

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
        machineRpcWithServerScopeMock.mockReset();
        getStateMock.mockReset();
    });

    it('paginates real git history and supports reset reload', async () => {
        const workspace = createRepoWithCommits(65);
        const sessionId = 'session-history-1';
        const harness = createGitSessionRpcHarness(workspace);
        getStateMock.mockReturnValue({
            settings: { scmGitRepoPreferredBackend: 'git' },
            sessions: {
                [sessionId]: {
                    active: true,
                    metadata: {
                        path: workspace,
                        machineId: 'machine-1',
                    },
                },
            },
        });
        machineRpcWithServerScopeMock.mockImplementation(async (params: {
            method: string;
            payload: unknown;
        }) => await harness(sessionId, params.method, params.payload));

        const hook = await renderHook(
            (props: HookProps) => useScmCommitHistory(props),
            {
                initialProps: {
                    sessionId,
                    readLogEnabled: true,
                    sessionPath: workspace,
                },
            },
        );

        await act(async () => {
            await hook.getCurrent().loadCommitHistory({ reset: true });
        });

        const firstPage = hook.getCurrent();
        expect(firstPage.historyEntries).toHaveLength(50);
        expect(firstPage.historyHasMore).toBe(true);

        await act(async () => {
            await hook.getCurrent().loadCommitHistory();
        });

        const secondPage = hook.getCurrent();
        expect(secondPage.historyEntries).toHaveLength(65);
        expect(secondPage.historyHasMore).toBe(false);

        const uniqueShas = new Set(secondPage.historyEntries.map((entry) => entry.sha));
        expect(uniqueShas.size).toBe(secondPage.historyEntries.length);

        await act(async () => {
            await hook.getCurrent().loadCommitHistory({ reset: true });
        });

        const resetPage = hook.getCurrent();
        expect(resetPage.historyEntries).toHaveLength(50);
        expect(resetPage.historyHasMore).toBe(true);

        await hook.unmount();
    });

    it('falls back to limit expansion when backend ignores skip (legacy daemon)', async () => {
        const workspace = createRepoWithCommits(65);
        const sessionId = 'session-history-legacy-skip';
        const harness = createGitSessionRpcHarness(workspace);

        getStateMock.mockReturnValue({
            settings: { scmGitRepoPreferredBackend: 'git' },
            sessions: {
                [sessionId]: {
                    active: true,
                    metadata: {
                        path: workspace,
                        machineId: 'machine-1',
                    },
                },
            },
        });

        // Simulate an older daemon that ignores `skip` and always returns the first page.
        machineRpcWithServerScopeMock.mockImplementation(async (params: {
            method: string;
            payload: any;
        }) => {
            if (params.method === 'scm.log.list' && params.payload && typeof params.payload === 'object') {
                return await harness(sessionId, params.method, { ...params.payload, skip: 0 });
            }
            return await harness(sessionId, params.method, params.payload);
        });

        const hook = await renderHook(
            (props: HookProps) => useScmCommitHistory(props),
            {
                initialProps: {
                    sessionId,
                    readLogEnabled: true,
                    sessionPath: workspace,
                },
            },
        );

        await act(async () => {
            await hook.getCurrent().loadCommitHistory({ reset: true });
        });

        const firstPage = hook.getCurrent();
        expect(firstPage.historyEntries).toHaveLength(50);
        expect(firstPage.historyHasMore).toBe(true);

        await act(async () => {
            await hook.getCurrent().loadCommitHistory();
        });

        const secondPage = hook.getCurrent();
        // Should still make progress by expanding limit while keeping skip=0.
        expect(secondPage.historyEntries).toHaveLength(65);
        expect(secondPage.historyHasMore).toBe(false);

        await hook.unmount();
    });

    it('clears history when log reading is disabled by backend capabilities', async () => {
        const workspace = createRepoWithCommits(3);
        const sessionId = 'session-history-2';
        getStateMock.mockReturnValue({
            settings: { scmGitRepoPreferredBackend: 'git' },
            sessions: {
                [sessionId]: {
                    active: true,
                    metadata: {
                        path: workspace,
                        machineId: 'machine-1',
                    },
                },
            },
        });

        const hook = await renderHook(
            (props: HookProps) => useScmCommitHistory(props),
            {
                initialProps: {
                    sessionId,
                    readLogEnabled: false,
                    sessionPath: workspace,
                },
            },
        );

        await act(async () => {
            await hook.getCurrent().loadCommitHistory({ reset: true });
        });

        const current = hook.getCurrent();
        expect(current.historyEntries).toEqual([]);
        expect(current.historyHasMore).toBe(false);

        await hook.unmount();
    });

    it('loads sapling history entries through session scm log RPC', async () => {
        const workspace = createSaplingRepoWithCommits(3);
        const sessionId = 'session-history-sapling-1';
        const harness = createSaplingSessionRpcHarness(workspace);
        getStateMock.mockReturnValue({
            settings: { scmGitRepoPreferredBackend: 'git' },
            sessions: {
                [sessionId]: {
                    active: true,
                    metadata: {
                        path: workspace,
                        machineId: 'machine-1',
                    },
                },
            },
        });
        machineRpcWithServerScopeMock.mockImplementation(async (params: {
            method: string;
            payload: unknown;
        }) => await harness(sessionId, params.method, params.payload));

        const hook = await renderHook(
            (props: HookProps) => useScmCommitHistory(props),
            {
                initialProps: {
                    sessionId,
                    readLogEnabled: true,
                    sessionPath: workspace,
                },
            },
        );

        await act(async () => {
            await hook.getCurrent().loadCommitHistory({ reset: true });
        });

        const current = hook.getCurrent();
        expect(current.historyEntries.length).toBeGreaterThan(0);
        expect(current.historyEntries[0]?.subject).toBe('commit-3');
        expect(current.historyHasMore).toBe(false);

        await hook.unmount();
    });

    it('keeps last-known history entries visible when a reset reload fails', async () => {
        const workspace = createRepoWithCommits(65);
        const sessionId = 'session-history-swr-reset';
        const harness = createGitSessionRpcHarness(workspace);
        let failReset = false;

        getStateMock.mockReturnValue({
            settings: { scmGitRepoPreferredBackend: 'git' },
            sessions: {
                [sessionId]: {
                    active: true,
                    metadata: {
                        path: workspace,
                        machineId: 'machine-1',
                    },
                },
            },
        });

        machineRpcWithServerScopeMock.mockImplementation(async (params: {
            method: string;
            payload: any;
        }) => {
            if (params.method === 'scm.log.list' && failReset) {
                return { success: false, error: 'offline' };
            }
            return await harness(sessionId, params.method, params.payload);
        });

        const hook = await renderHook(
            (props: HookProps) => useScmCommitHistory(props),
            {
                initialProps: {
                    sessionId,
                    readLogEnabled: true,
                    sessionPath: workspace,
                },
            },
        );

        await act(async () => {
            await hook.getCurrent().loadCommitHistory({ reset: true });
        });

        const firstPage = hook.getCurrent();
        expect(firstPage.historyEntries).toHaveLength(50);

        failReset = true;
        await act(async () => {
            await hook.getCurrent().loadCommitHistory({ reset: true });
        });

        const afterFailedReset = hook.getCurrent();
        expect(afterFailedReset.historyEntries).toHaveLength(50);
        expect(afterFailedReset.historyHasMore).toBe(false);

        await hook.unmount();
    });
});
