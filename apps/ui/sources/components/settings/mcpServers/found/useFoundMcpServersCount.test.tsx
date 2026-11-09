import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { DaemonMcpServersDetectResponseSchema } from '@happier-dev/protocol/mcp/servers/daemonRpcV1';
import { prepareWarmCacheEncryptionKey } from '@/sync/domains/state/warmCacheEncryptionKey';
import { saveFoundWarmCacheEntry } from '@/sync/domains/state/warmCachePersistence';
import { useFoundMcpServersCount } from './useFoundMcpServersCount';

afterEach(standardCleanup);

it('counts held findings only in the requested Home/Account, without rendering on unrelated or same-count changes', async () => {
    await prepareWarmCacheEncryptionKey();
    const scope = { serverId: 'mcp-count-home', accountId: 'mcp-count-account' };
    const ids = Array.from({ length: 139 }, (_, i) => `machine-${i}`);
    const result = DaemonMcpServersDetectResponseSchema.parse({ ok: true, servers: [{ provider: 'claude', name: 'local',
        transport: 'stdio', stdio: { command: 'tool', args: [] }, envKeys: [], enabled: true,
        source: { kind: 'user', path: '/config.json' } }] });
    if (!result.ok) throw new Error('Expected a successful detection fixture');
    const save = (machineId: string, observedAt: number, count = 1, accountId = scope.accountId) =>
        saveFoundWarmCacheEntry(scope.serverId, accountId, { kind: 'mcp_server', machineId, observedAt,
            result: { ...result, servers: Array.from({ length: count }, () => result.servers[0]!) } });
    for (const id of ids) save(id, 1);
    let renders = 0;
    const fetches = vi.spyOn(globalThis, 'fetch');
    const hook = await renderHook(({ enabled, accountId }: { enabled: boolean; accountId: string }) => {
        renders++;
        return useFoundMcpServersCount(ids, { ...scope, accountId }, enabled);
    }, { initialProps: { enabled: true, accountId: scope.accountId } });
    expect(hook.getCurrent()).toBe(139);
    const settledRenders = renders;
    await act(async () => {
        for (const id of ids) save(id, 2);
        save('unrequested', 1, 5);
        save(ids[0]!, 1, 9, 'another-account');
    });
    expect(renders).toBe(settledRenders);
    await act(async () => { save(ids[0]!, 3, 2); });
    expect(hook.getCurrent()).toBe(140);
    await hook.rerender({ enabled: false, accountId: scope.accountId });
    expect(hook.getCurrent()).toBeNull();
    const inactiveRenders = renders;
    await act(async () => { save(ids[0]!, 4, 3); });
    expect(renders).toBe(inactiveRenders);
    await hook.rerender({ enabled: true, accountId: scope.accountId });
    expect(hook.getCurrent()).toBe(141);
    await hook.rerender({ enabled: true, accountId: 'unobserved-account' });
    expect(hook.getCurrent()).toBeNull();
    expect(fetches).not.toHaveBeenCalled();
    fetches.mockRestore();
    await hook.unmount();
});
