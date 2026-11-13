import { afterEach, expect, it, vi } from 'vitest';
import { act, renderHook, standardCleanup } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { RegistryUpdateCheckState } from '@/registries/useRegistryUpdateCheck';
import type { InstalledSkillRow } from '../catalog/storeKinds';
import type { StorePluginUpdateEntry } from './useStorePluginUpdates';

installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
const { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } =
  await import('@/sync/domains/scope/activeServerAccountScope');
const { createSkillsSurfaceItem } = await import('@/dev/testkit/harness/skillsSurfaceHarness');
const { useStoreUpdates } = await import('./useStoreUpdates');
const { useStoreUpdatesCount, subscribeStoreUpdatesCount, publishStoreUpdatesCount } = await import('./storeUpdatesSummary');

afterEach(() => {
  standardCleanup();
  retireActiveServerAccountScopeLifetime();
  storage.setState(storage.getInitialState(), true);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('shares the page count with passive badges, retains equal summaries, and withdraws them with Account authority', async () => {
  const scope = { serverId: 'srv_store_updates', accountId: 'account-a' };
  publishAppliedActiveServerSnapshot({ serverId: scope.serverId, serverUrl: 'https://store-updates.test', generation: 1 });
  storage.setState({ profileScope: scope });
  const lifetime = captureActiveServerAccountScopeLifetime();
  if (!lifetime) throw new Error('Expected the real active Account lifetime');
  const row = (id: string): InstalledSkillRow => ({ kind: 'skill', key: `skill:${id}`, scope, reach: [], native: createSkillsSurfaceItem(id, {
    provenance: { kind: 'registry', registry: { sourceId: 'skills', sourceUrl: 'https://github.com/team/skills', format: 'git',
      itemId: id, importedAt: 1, ref: { kind: 'version', version: '1' } } },
  }) });
  let rows = [row('sample')];
  const noPlugins: readonly StorePluginUpdateEntry[] = [];
  let check: RegistryUpdateCheckState = { checking: false, checkedAt: null, failed: false, code: null, results: [] };
  let presented = true;
  let inventoryReady = true;
  // Fetch and timers are genuine system boundaries. All model, publication,
  // subscription and Account retirement logic runs through its real owner.
  const fetches = vi.spyOn(globalThis, 'fetch');
  vi.useFakeTimers();
  const page = await renderHook(() => useStoreUpdates(rows, check, scope, presented, inventoryReady, noPlugins));
  const column = await renderHook(() => useStoreUpdatesCount(scope));
  const phone = await renderHook(() => useStoreUpdatesCount(scope));
  const publications = vi.fn();
  const stop = subscribeStoreUpdatesCount(publications);
  try {
    expect(column.getCurrent()).toBeNull();
    expect(phone.getCurrent()).toBeNull();
    check = { ...check, checkedAt: 10, results: [{ kind: 'skill', key: 'sample', upstream: { state: 'update_available' } }],
      basis: new Map(rows.map(row => [row.key, JSON.stringify([row.native.provenance, row.native.revision])])) };
    await page.rerender();
    expect(page.getCurrent().count).toBe(1);
    expect(column.getCurrent()).toBe(1);
    expect(phone.getCurrent()).toBe(1);
    publications.mockClear();
    check = { ...check, checkedAt: 11 };
    await page.rerender();
    expect(publications).not.toHaveBeenCalled();

    rows = rows.map(row => ({ ...row, native: { ...row.native, revision: '2:2', upstream: { state: 'current' as const } } }));
    await page.rerender();
    expect(page.getCurrent().count).toBe(0);
    expect(column.getCurrent()).toBe(0);
    expect(phone.getCurrent()).toBe(0);

    rows = [...rows, row('second')];
    await page.rerender();
    expect(column.getCurrent()).toBeNull();
    expect(phone.getCurrent()).toBeNull();
    check = { ...check, results: [...check.results, { kind: 'skill', key: 'second', upstream: { state: 'removed_from_source' } }],
      basis: new Map(rows.map(row => [row.key, JSON.stringify([row.native.provenance, row.native.revision])])) };
    await page.rerender();
    expect(column.getCurrent()).toBe(2);
    check = { ...check, failed: true };
    await page.rerender();
    expect(column.getCurrent()).toBeNull();
    check = { ...check, failed: false };
    inventoryReady = false;
    await page.rerender();
    expect(column.getCurrent()).toBeNull();
    inventoryReady = true;
    await page.rerender();
    expect(column.getCurrent()).toBe(2);

    // Leaving Updates retains its last checked scalar; closed badges do not
    // acquire details or schedule revalidation to maintain it.
    presented = false;
    await page.rerender();
    await page.unmount();
    await act(async () => { vi.advanceTimersByTime(60_000); });
    expect(phone.getCurrent()).toBe(2);
    expect(fetches).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => { retireActiveServerAccountScopeLifetime(); });
    expect(column.getCurrent()).toBeNull();
    expect(phone.getCurrent()).toBeNull();
    await act(async () => { publishStoreUpdatesCount(lifetime, 9); });
    expect(phone.getCurrent()).toBeNull();
  } finally {
    stop();
    await page.unmount();
    await column.unmount();
    await phone.unmount();
  }
});
