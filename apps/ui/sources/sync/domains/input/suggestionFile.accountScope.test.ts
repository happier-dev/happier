import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createDeferred } from '@/dev/testkit';
import { searchFiles, fileSearchCache } from './suggestionFile';

const boundary = vi.hoisted(() => ({ rpc: vi.fn() }));
// The machine network is the boundary; composer, cache, credential binding and DTOs stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (input: unknown) => boundary.rpc(input),
}));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);

beforeEach(async () => {
    await harness.reset();
    fileSearchCache.clearCache();
    boundary.rpc.mockReset();
});

describe('composer file suggestions addressed to another Home', () => {
    it('uses the addressed credential Account and retires its pending/cache results when that credential changes', async () => {
        await harness.addHome({ name: 'Foreground A', serverUrl: 'https://suggestions-a.test', accountId: 'account-a' });
        const serverId = await harness.addHome({ name: 'Selected B', serverUrl: 'https://suggestions-b.test', accountId: 'account-b', active: false });
        const scope = { serverId, machineId: 'same-machine', rootPath: '/repo' };
        const entered = createDeferred<void>();
        const release = createDeferred<{ ok: true; paths: string[]; truncated: false }>();
        boundary.rpc.mockImplementationOnce((request: { accountId?: string }) => {
            entered.resolve();
            expect(request.accountId).toBe('account-b');
            return release.promise;
        });
        const pending = searchFiles(scope, '', { limit: 50 });
        // Attach the rejection observer before credential retirement.
        const rejected = expect(pending).rejects.toMatchObject({ code: 'WORKSPACE_FILE_SEARCH_UNAVAILABLE' });
        try {
            await entered.promise;
            await harness.switchAccount(serverId, 'replacement-b');
        } finally {
            release.resolve({ ok: true, paths: ['old-b.ts'], truncated: false });
        }
        await rejected;
        boundary.rpc.mockResolvedValue({ ok: true, paths: ['new-b.ts'], truncated: false });
        expect((await searchFiles(scope, '', { limit: 50 })).map(item => item.fullPath)).toEqual(['new-b.ts']);
        expect(boundary.rpc.mock.calls.at(-1)?.[0]).toMatchObject({ serverId, accountId: 'replacement-b' });
        await searchFiles(scope, '', { limit: 50 });
        expect(boundary.rpc).toHaveBeenCalledTimes(2);
    });
});
