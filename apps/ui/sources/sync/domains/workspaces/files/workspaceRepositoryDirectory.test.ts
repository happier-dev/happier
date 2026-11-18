import { beforeEach, describe, expect, it, vi } from 'vitest';

import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const listDirectoryOnMachine = vi.fn();

/**
 * Two workspaces reached through two different servers. Same machine id, same root path — a
 * machine id is only unique within its server — so these must not share a cache entry, and
 * they must each be listed through their own server.
 */
const SCOPE_A = { serverId: '', machineId: 'm1', rootPath: '/repo' };
const SCOPE_B = { ...SCOPE_A };

async function answerDirectoryReads(scope: typeof SCOPE_A) {
    await answerExternalActionAccountForHome(homes, scope.serverId, {
        actionId: 'daemon.filesystem.listDirectory', machineId: scope.machineId, tokenEpoch: 0,
        execute: input => listDirectoryOnMachine(scope.serverId, input),
    });
}

beforeEach(async () => {
    await homes.reset();
    listDirectoryOnMachine.mockReset();
    SCOPE_A.serverId = await homes.addHome({ name: 'Tree A', serverUrl: 'https://tree-a.test',
        serverIdentityId: 'srv_files_tree_a', accountId: 'tree-account-a', currentAccount: true });
    const { clearCachedWorkspaceRepositoryDirectoryEntries } = await import('./workspaceRepositoryDirectory');
    const { buildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
    clearCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey: buildWorkspaceCacheKey(SCOPE_A) });
    await answerDirectoryReads(SCOPE_A);
});

describe('workspaceRepositoryDirectory', () => {
    it('caches directory entries by workspace scope + directoryPath, and lists through that scope\'s server', async () => {
        SCOPE_B.serverId = await homes.addHome({ name: 'Tree B', serverUrl: 'https://tree-b.test',
            serverIdentityId: 'srv_files_tree_b', accountId: 'tree-account-b', currentAccount: true, active: false });
        await answerDirectoryReads(SCOPE_B);
        listDirectoryOnMachine.mockResolvedValue({
            success: true,
            truncated: false,
            entries: [
                { name: 'src', type: 'directory' },
                { name: 'README.md', type: 'file', size: 10, modified: 1 },
            ],
        });

        const mod = await import('./workspaceRepositoryDirectory');

        const res1 = await mod.listWorkspaceRepositoryDirectoryEntries({
            scope: SCOPE_A,
            directoryPath: '',
        });
        expect(res1.ok).toBe(true);

        const resCached = await mod.warmWorkspaceRepositoryDirectoryCache({
            scope: SCOPE_A,
            directoryPath: '',
        });
        expect(resCached.ok).toBe(true);

        // A different server addresses a different workspace and must not reuse A's cache.
        const res2 = await mod.warmWorkspaceRepositoryDirectoryCache({
            scope: SCOPE_B,
            directoryPath: '',
        });
        expect(res2.ok).toBe(true);

        expect(listDirectoryOnMachine).toHaveBeenCalledTimes(2);
        // Each read went out on the server its own scope names — the entry cannot be filed
        // under one server while being read through another.
        const serverIds = listDirectoryOnMachine.mock.calls.map(([serverId]) => serverId);
        expect(serverIds).toEqual([SCOPE_A.serverId, SCOPE_B.serverId]);
    });

    it('clears cached entries for a workspace', async () => {
        listDirectoryOnMachine.mockResolvedValue({
            success: true,
            truncated: false,
            entries: [
                { name: 'a', type: 'file' },
            ],
        });

        const mod = await import('./workspaceRepositoryDirectory');

        await mod.warmWorkspaceRepositoryDirectoryCache({
            scope: SCOPE_A,
            directoryPath: '',
        });
        expect(listDirectoryOnMachine).toHaveBeenCalledTimes(1);

        // The key-addressed clear must name the same entry the scope-addressed warm filled;
        // both go through `tryBuildWorkspaceCacheKey`, and this is where that agreement holds.
        const { buildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
        mod.clearCachedWorkspaceRepositoryDirectoryEntries({
            workspaceCacheKey: buildWorkspaceCacheKey(SCOPE_A),
        });

        await mod.warmWorkspaceRepositoryDirectoryCache({
            scope: SCOPE_A,
            directoryPath: '',
        });
        expect(listDirectoryOnMachine).toHaveBeenCalledTimes(2);
    });

    it('prunes cached descendants when a refreshed parent no longer contains their directory', async () => {
        const mod = await import('./workspaceRepositoryDirectory');
        const { buildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
        const workspaceCacheKey = buildWorkspaceCacheKey(SCOPE_A);
        mod.setCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: '', entries: [{ name: 'src', type: 'directory' }] });
        mod.setCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: 'src', entries: [{ name: 'old.ts', type: 'file' }] });
        mod.setCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: 'src/deep', entries: [{ name: 'stale.ts', type: 'file' }] });
        mod.setCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: 'src-other', entries: [{ name: 'keep.ts', type: 'file' }] });
        listDirectoryOnMachine.mockResolvedValue({ success: true, entries: [] });
        await mod.listWorkspaceRepositoryDirectoryEntries({ scope: SCOPE_A, directoryPath: '' });
        expect(mod.getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: 'src' })).toBeNull();
        expect(mod.getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: 'src/deep' })).toBeNull();
        expect(mod.getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: 'src-other' })).toEqual([{ name: 'keep.ts', type: 'file' }]);
    });
});


describe('workspace directory Git ignore metadata', () => {
    it('preserves classification through the canonical workspace cache', async () => {
        listDirectoryOnMachine.mockResolvedValue({ success: true, truncated: false, gitIgnoreAvailable: true,
            entries: [{ name: 'node_modules', type: 'directory', gitIgnored: true }, { name: '.env.example', type: 'file', gitIgnored: false }],
        });
        const mod = await import('./workspaceRepositoryDirectory');
        const input = { scope: SCOPE_A, directoryPath: 'classified' };
        const result = await mod.listWorkspaceRepositoryDirectoryEntries(input);
        expect(result).toMatchObject({ ok: true, gitIgnoreAvailable: true, entries: [{ gitIgnored: true }, { gitIgnored: false }] });
        expect(await mod.warmWorkspaceRepositoryDirectoryCache(input)).toEqual(result);
    });
    it('keeps old daemon entries unclassified and visible', async () => {
        listDirectoryOnMachine.mockResolvedValue({ success: true, truncated: false,
            entries: [{ name: 'node_modules', type: 'directory' }],
        });
        const mod = await import('./workspaceRepositoryDirectory');
        expect(await mod.listWorkspaceRepositoryDirectoryEntries({ scope: SCOPE_A, directoryPath: 'legacy' })).toMatchObject({ ok: true, gitIgnoreAvailable: false, entries: [{ name: 'node_modules' }] });
    });
});

describe('workspace directory cache across an Account change on one Home', () => {
    const response = (name: string) => ({ success: true, truncated: false, entries: [{ name, type: 'file' }] });

    it('withdraws the previous Account tree, wakes mounted trees, and retains no read still in flight', async () => {
        const { tryBuildWorkspaceCacheKey } = await import('@/sync/domains/workspaces/workspaceScope');
        const { getCachedWorkspaceRepositoryDirectoryEntries, listWorkspaceRepositoryDirectoryEntries, warmWorkspaceRepositoryDirectoryCache } = await import('./workspaceRepositoryDirectory');
        const { subscribeWorkspaceRepositoryDirectoryRevision } = await import('./workspaceRepositoryDirectoryRevision');
        const workspaceCacheKey = tryBuildWorkspaceCacheKey(SCOPE_A)!;
        listDirectoryOnMachine.mockResolvedValueOnce(response('a-private.txt'));
        await listWorkspaceRepositoryDirectoryEntries({ scope: SCOPE_A, directoryPath: '' });
        expect(getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: '' })?.[0]?.name).toBe('a-private.txt');

        const woken = vi.fn();
        const stop = subscribeWorkspaceRepositoryDirectoryRevision(workspaceCacheKey, woken);
        let settleHeld = (_value: unknown) => {};
        listDirectoryOnMachine.mockImplementationOnce(() => new Promise(resolve => { settleHeld = resolve; }));
        const held = warmWorkspaceRepositoryDirectoryCache({ scope: SCOPE_A, directoryPath: 'src' });
        await vi.waitFor(() => expect(listDirectoryOnMachine).toHaveBeenCalledTimes(2));

        await homes.switchAccount(SCOPE_A.serverId, 'tree-account-b', { currentAccount: true });
        expect(getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: '' })).toBeNull();
        expect(woken).toHaveBeenCalled();

        settleHeld(response('a-private-held.txt'));
        await held;
        expect(getCachedWorkspaceRepositoryDirectoryEntries({ workspaceCacheKey, directoryPath: 'src' })).toBeNull();
        stop();
    });
});
