import { afterEach, expect, it } from 'vitest';
import { AccountSettingsSchema } from '@happier-dev/protocol';
import { createManagedRunLaunchFixture } from '@/providers/lifecycle/managedRunLaunch.testkit';
import { readProviderSettingsForCli } from '@/providers/settings/read';
import { resolveProviderConnectionForMachine } from '@/providers/registry';
import {
  clearActiveAccountSettingsSnapshot, commitActiveProviderConnectionsCatalog,
  getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot, subscribeActiveAccountSettingsKeys,
} from './activeAccountSettingsSnapshot';

afterEach(resetActiveAccountSettingsSnapshotForTests);

it('keeps grant authorization quiet on unrelated preferences while observing grant withdrawal and Account retirement', async () => {
  const fixture = await createManagedRunLaunchFixture();
  setActiveAccountSettingsSnapshot(fixture.snapshot);
  let rechecks = 0;
  let authorized = true;
  const release = subscribeActiveAccountSettingsKeys({ settings: ['providerDefaultModelSelectionsByAgentTargetKeyV1', 'secrets'],
    facets: ['providerConnectionsCatalog', 'savedSecretResources', 'savedSecretCatalogState'],
  }, () => {
    rechecks++;
    const snapshot = getActiveAccountSettingsSnapshot();
    if (snapshot?.providerConnectionsCatalog?.status !== 'ready') { authorized = false; return; }
    const resolution = resolveProviderConnectionForMachine({ connectionId: fixture.record.connectionId,
      machineId: fixture.machineId, providerSettings: readProviderSettingsForCli(snapshot).settings,
      registry: fixture.contributes, dnsEvidenceByEndpointUrl: new Map() });
    authorized = resolution.status === 'resolved' && resolution.record.authorization.authorized;
  });
  try {
    for (let index = 0; index < 25; index++) {
      setActiveAccountSettingsSnapshot({ ...getActiveAccountSettingsSnapshot()!, settingsVersion: index + 2,
        settings: AccountSettingsSchema.parse({ ...fixture.snapshot.settings, analyticsOptOut: index % 2 === 0 }) });
    }
    expect(rechecks).toBe(0);
    if (fixture.snapshot.providerConnectionsCatalog?.status !== 'ready') throw new Error('Expected real fixture catalog');
    expect(commitActiveProviderConnectionsCatalog({ scopeKey: fixture.snapshot.scopeKey!,
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken(), catalog: { status: 'ready', revision: 2,
        catalog: { ...fixture.snapshot.providerConnectionsCatalog.catalog, machineGrants: [] } } })).toBe(true);
    expect(rechecks).toBe(1);
    expect(authorized).toBe(false);
    setActiveAccountSettingsSnapshot({ ...getActiveAccountSettingsSnapshot()!, settingsVersion: 27,
      settingsSecretsReadKeys: [new Uint8Array([1])] });
    expect(rechecks).toBe(2);
    clearActiveAccountSettingsSnapshot();
    expect(rechecks).toBe(3);
  } finally { release(); await fixture.cleanup(); }
});
