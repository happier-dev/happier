import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { createInstalledPluginCapabilityFixture } from '@/dev/testkit/fixtures/pluginCapabilityFixtures';
import { useStorePluginUpdates } from './useStorePluginUpdates';

afterEach(standardCleanup);
it('retains unknown coverage, supplies native update review props, and performs zero reads on open or idle', async () => {
    const detail = createInstalledPluginCapabilityFixture({ pluginId: 'acme.tools', source: { kind: 'npm', locator: '@acme/tools', trustPolicy: 'trusted' } });
    // The Account projection is not a daemon lifecycle authority: only detail can offer review.
    const row = { key: 'plugin:acme.tools', native: { pluginId: 'acme.tools' }, detail };
    let rows: Parameters<typeof useStorePluginUpdates>[0]['rows'] = [row];
    let results: import('@/registries/useRegistryUpdateCheck').RegistryUpdateCheckState['results'] = [];
    const check = () => ({ checking: false, failed: false, checkedAt: null, code: null, results });
    const fetches = vi.spyOn(globalThis, 'fetch');
    vi.useFakeTimers();
    const hook = await renderHook(() => useStorePluginUpdates({ rows, check: check() }));
    try {
        expect(hook.getCurrent().count).toBeNull();
        expect(hook.getCurrent().entries[0]?.state).toBe('unknown');
        results = [{ kind: 'plugin', key: 'acme.tools', upstream: { state: 'update_available', latest: { kind: 'version', version: '2' } } }];
        await hook.rerender();
        expect(hook.getCurrent().entries[0]?.state).toBe('available');
        expect(hook.getCurrent().entries[0]?.review).toEqual({ action: 'update', pluginId: 'acme.tools' });
        results = [{ kind: 'plugin', key: 'acme.tools', upstream: { state: 'unchecked', reason: { state: 'needs_machine' } } }];
        await hook.rerender();
        expect(hook.getCurrent().entries[0]).toMatchObject({ state: 'unchecked', reason: { state: 'needs_machine' } });
        rows = [{ key: row.key, native: row.native }];
        await hook.rerender();
        expect(hook.getCurrent().entries[0]?.review).toBeUndefined();
        await act(async () => { vi.advanceTimersByTime(60_000); });
        expect(fetches).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    } finally { await hook.unmount(); vi.useRealTimers(); vi.restoreAllMocks(); }
});
