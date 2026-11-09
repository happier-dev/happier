import { afterEach, expect, it } from 'vitest';
import { AccountSettingsSchema, ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1, ProviderConnectionsCatalogV1Schema } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { beginActiveProviderConnectionsCatalogRefresh, commitActiveProviderConnectionsCatalog,
  getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsKeys } from './activeAccountSettingsSnapshot';

afterEach(resetActiveAccountSettingsSnapshotForTests);

it('publishes only real Provider catalog changes and retains unchanged rows across revision, reorder and withdrawal', () => {
  const catalog = ProviderConnectionsCatalogV1Schema.parse({ ...DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1,
    connections: Array.from({ length: 400 }, (_, index) => ({ v: 1, id: `pc_${index}`,
      source: { kind: 'contribution', contributionKey: 'acme.provider/gateway' }, role: 'named',
      displayName: `Connection ${index}`, displayNameMode: 'custom', revision: 1, createdAt: 1, updatedAt: 1 })),
    manualModelsByConnectionId: { pc_199: [{ id: 'manual', name: 'Manual', addedAt: 1 }] },
  });
  setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'provider-publication',
    settings: AccountSettingsSchema.parse({}), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [],
    providerConnectionsCatalog: { status: 'ready', revision: 1, catalog } });
  const bound = { scopeKey: 'provider-publication', lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() };
  const names: string[] = [];
  const release = subscribeActiveAccountSettingsKeys({ facets: ['providerConnectionsCatalog'] }, (_previous, next) => {
    names.push(next?.providerConnectionsCatalog?.status === 'ready'
      ? readProviderSettingsForCli(next).settings.connections.find(row => row.id === 'pc_200')?.displayName ?? 'removed'
      : 'withdrawn');
  });
  try {
    for (let i = 0; i < 5; i++) {
      beginActiveProviderConnectionsCatalogRefresh(bound);
      commitActiveProviderConnectionsCatalog({ ...bound, catalog: { status: 'ready', revision: 1, catalog: structuredClone(catalog) } });
    }
    expect(names).toEqual([]);
    const changed = structuredClone(catalog);
    changed.connections[200] = { ...changed.connections[200]!, displayName: 'Renamed', revision: 2 };
    // Reordering must preserve identity by row id, rather than by array position.
    changed.connections.reverse();
    commitActiveProviderConnectionsCatalog({ ...bound, catalog: { status: 'ready', revision: 2, catalog: changed } });
    expect(names).toEqual(['Renamed']);
    const admitted = getActiveAccountSettingsSnapshot()?.providerConnectionsCatalog;
    if (admitted?.status !== 'ready') throw new Error('Expected admitted Provider authority');
    expect(admitted.catalog.connections.find(row => row.id === 'pc_199')).toBe(catalog.connections[199]);
    expect(admitted.catalog.connections.find(row => row.id === 'pc_200')).not.toBe(catalog.connections[200]);
    expect(admitted.catalog.accountGrants).toBe(catalog.accountGrants);
    expect(admitted.catalog.manualModelsByConnectionId[ProviderConnectionIdSchema.parse('pc_199')]).toBe(catalog.manualModelsByConnectionId[ProviderConnectionIdSchema.parse('pc_199')]);
    commitActiveProviderConnectionsCatalog({ ...bound, catalog: { status: 'unavailable', reason: 'forbidden' } });
    expect(names).toEqual(['Renamed', 'withdrawn']);
    expect(() => readProviderSettingsForCli(getActiveAccountSettingsSnapshot()!)).toThrow();
  } finally { release(); }
});
