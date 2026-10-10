import { describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { DEFAULT_PROVIDER_SETTINGS_V1, ProviderSettingsV1Schema } from '@happier-dev/protocol/providers/settings/v1';
import type { ProviderConnectionsCatalogSnapshotV1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol';
import { readProviderSettingsForCli } from './read';

describe('readProviderSettingsForCli', () => {
  it('reads a ready catalog independently of the retired raw settings subtree', () => {
    const providerSettings = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1, connections: [{
      v: 1, id: 'pc_catalog', source: { kind: 'contribution', contributionKey: 'acme.gateway/gateway' },
      role: 'default', displayName: 'Catalog connection', displayNameMode: 'automatic',
      deployment: { kind: 'external' }, revision: 1, createdAt: 1, updatedAt: 1,
    }] });
    const { defaultsByAgentTargetKey: _defaults, ...catalog } = providerSettings;
    const result = readProviderSettingsForCli({
      settings: accountSettingsParse({}),
      rawSettings: { providerSettingsV1: { v: 99 } },
      providerConnectionsCatalog: { status: 'ready', revision: 7, catalog },
    });
    expect(result.settings).toEqual(providerSettings);
    expect(result.diagnostics).toEqual([]);
  });

  it.each<ProviderConnectionsCatalogSnapshotV1 | undefined>([undefined, { status: 'loading' }, { status: 'unavailable', reason: 'unreachable' }])(
    'refuses incomplete catalog authority despite usable retired settings', (providerConnectionsCatalog) => {
      expect(() => readProviderSettingsForCli({ settings: accountSettingsParse({}), providerConnectionsCatalog,
        rawSettings: { providerSettingsV1: DEFAULT_PROVIDER_SETTINGS_V1 } }))
        .toThrow(expect.objectContaining({ code: 'provider_settings_invalid' }));
    },
  );

  it('allows safe partial neighbors for display but never for authorization', () => {
    const { defaultsByAgentTargetKey: _defaults, ...catalog } = DEFAULT_PROVIDER_SETTINGS_V1;
    const diagnostics = [{ path: 'connections[1]', reason: 'invalid_record' }];
    const snapshot = { settings: accountSettingsParse({}), providerConnectionsCatalog: {
      status: 'partial' as const, revision: 7, catalog, diagnostics,
    } };
    expect(readProviderSettingsForCli(snapshot, { purpose: 'display' })).toEqual({
      settings: DEFAULT_PROVIDER_SETTINGS_V1, diagnostics,
    });
    expect(() => readProviderSettingsForCli(snapshot))
      .toThrow(expect.objectContaining({ code: 'provider_settings_invalid' }));
  });

  it('composes genuine default intent without erasing a temporarily missing catalog connection', () => {
    const selection = SessionModelSelectionV1Schema.parse({ v: 1, updatedAt: 1,
      ref: { agentTargetKey: 'backend:codex', providerConnectionId: 'pc_missing', modelId: 'model-a' } });
    const defaults = { [selection.ref.agentTargetKey]: selection };
    const { defaultsByAgentTargetKey: _defaults, ...catalog } = DEFAULT_PROVIDER_SETTINGS_V1;
    const result = readProviderSettingsForCli({ settings: accountSettingsParse({
      providerDefaultModelSelectionsByAgentTargetKeyV1: defaults,
    }), providerConnectionsCatalog: { status: 'ready', revision: 7, catalog } });
    expect(result.settings.defaultsByAgentTargetKey).toEqual(defaults);
    expect(result.settings.connections).toEqual([]);
  });
});
