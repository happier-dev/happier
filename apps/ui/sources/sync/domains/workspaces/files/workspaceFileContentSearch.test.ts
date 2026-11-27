import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { searchWorkspaceFileContents } from './workspaceFileContentSearch';

const rpc = vi.hoisted(() => ({ call: vi.fn() }));
// The machine network transport is the only mocked boundary; schema and content service stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (input: unknown) => rpc.call(input),
}));

const scope = { serverId: 'home-b', machineId: 'machine-b', rootPath: '/repo/B' };

function lifetime(): ServerAccountScopeLifetime & { retire(): void } {
    let current = true;
    const retirements = new Set<() => void>();
    return {
        scope: { serverId: 'home-b', accountId: 'account-b' },
        isCurrent: () => current,
        onRetire: (cancel) => {
            retirements.add(cancel);
            return { dispose: () => { retirements.delete(cancel); } };
        },
        retire: () => {
            current = false;
            for (const cancel of retirements) cancel();
        },
    };
}

describe('searchWorkspaceFileContents', () => {
    beforeEach(() => { rpc.call.mockReset(); });

    it('searches the admitted managed filesystem instead of the controller root', async () => {
        const workspace = { v: 2 as const, serverId: scope.serverId, kind: 'managed' as const, workspaceId: 'project', managedId: 'guest',
            controller: { machineId: scope.machineId, installationId: 'installation' }, rootPath: scope.rootPath };
        const files = [{ path: 'src/a.ts', matches: [{ line: 1, column16: 1, length16: 6, text: 'needle', before: [], after: [] }] }];
        rpc.call.mockResolvedValue({ ok: true, files, hasMore: false, coverage: 'complete' });
        await expect(searchWorkspaceFileContents({ scope: { ...scope, workspace }, accountLifetime: lifetime(), query: 'needle' }))
            .resolves.toEqual({ items: files, hasMore: false, coverage: 'complete' });
        expect(rpc.call).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            method: 'daemon.workspaceFiles.search.v1', payload: expect.objectContaining({ query: 'needle', workspace }),
        }));
    });

    it('requests the displayed two context lines from the exact Home and Account without rewriting query text', async () => {
        const files = [{ path: 'src/a.ts', matches: [{ line: 4, column16: 4, length16: 6, text: 'é😀needle', before: ['before'], after: ['after'] }] }];
        rpc.call.mockResolvedValue({ ok: true, files, hasMore: true, coverage: 'partial' });
        const page = await searchWorkspaceFileContents({ scope, accountLifetime: lifetime(), query: ' needle ' });
        expect(page).toEqual({ items: files, hasMore: true, coverage: 'partial' });
        expect(rpc.call).toHaveBeenCalledWith(expect.objectContaining({
            serverId: 'home-b', accountId: 'account-b', machineId: 'machine-b',
            method: 'daemon.workspaceFiles.search.v1', operationTimeoutMs: null,
            payload: { rootPath: '/repo/B', query: ' needle ', contextLines: 2 },
        }));
        rpc.call.mockResolvedValueOnce({ ok: true, files, hasMore: false, coverage: 'partial' });
        await expect(searchWorkspaceFileContents({ scope, accountLifetime: lifetime(), query: 'needle' }))
            .resolves.toEqual({ items: files, hasMore: false, coverage: 'partial' });
    });

    it('keeps missing-listener, unsupported-method, invalid-pattern, and transport failures distinct from a complete empty search', async () => {
        const input = { scope, accountLifetime: lifetime(), query: 'needle' };
        rpc.call.mockRejectedValueOnce(Object.assign(new Error('Unavailable method'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }));
        await expect(searchWorkspaceFileContents(input)).resolves.toMatchObject({ coverage: 'unavailable', error: 'target_unavailable' });
        rpc.call.mockRejectedValueOnce(Object.assign(new Error('Missing method'), { rpcErrorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }));
        await expect(searchWorkspaceFileContents(input)).resolves.toMatchObject({ coverage: 'unavailable', error: 'update_required' });
        rpc.call.mockResolvedValueOnce({ ok: false, code: 'invalid_pattern' });
        await expect(searchWorkspaceFileContents(input)).resolves.toMatchObject({ coverage: 'unavailable', error: 'invalid_pattern' });
        rpc.call.mockResolvedValueOnce({ ok: false, code: 'root_not_found' });
        await expect(searchWorkspaceFileContents(input)).resolves.toMatchObject({ coverage: 'unavailable', error: 'root_not_found' });
        rpc.call.mockRejectedValueOnce(new Error('disconnected'));
        await expect(searchWorkspaceFileContents(input)).resolves.toMatchObject({ coverage: 'unavailable', error: 'transport_failed' });
        rpc.call.mockResolvedValueOnce({ ok: true, files: [], hasMore: false });
        await expect(searchWorkspaceFileContents(input)).resolves.toMatchObject({ coverage: 'unavailable', error: 'transport_failed' });
        rpc.call.mockResolvedValueOnce({ ok: true, files: [], hasMore: false, coverage: 'complete' });
        await expect(searchWorkspaceFileContents(input)).resolves.toEqual({ items: [], hasMore: false, coverage: 'complete' });
    });

    it('refuses a lifetime from a different Home and rejects a late result after Account retirement', async () => {
        const accountLifetime = lifetime();
        await expect(searchWorkspaceFileContents({ scope: { ...scope, serverId: 'home-a' }, accountLifetime, query: 'needle' })).resolves.toMatchObject({ coverage: 'unavailable', error: 'account_unavailable' });
        expect(rpc.call).not.toHaveBeenCalled();
        let publish!: (response: unknown) => void;
        rpc.call.mockImplementationOnce(() => new Promise((resolve) => { publish = resolve; }));
        const pending = searchWorkspaceFileContents({ scope, accountLifetime, query: 'needle' });
        const signal = rpc.call.mock.calls[0]?.[0].signal as AbortSignal;
        accountLifetime.retire();
        expect(signal.aborted).toBe(true);
        publish({ ok: true, files: [], hasMore: false, coverage: 'complete' });
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('carries caller cancellation to the machine request and never publishes the response after abort', async () => {
        const controller = new AbortController();
        rpc.call.mockImplementationOnce(async ({ signal }: { signal: AbortSignal }) => {
            controller.abort();
            expect(signal.aborted).toBe(true);
            return { ok: true, files: [], hasMore: false, coverage: 'complete' };
        });
        await expect(searchWorkspaceFileContents({ scope, accountLifetime: lifetime(), query: 'needle', signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    });
});
