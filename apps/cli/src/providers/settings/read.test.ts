import axios from 'axios';
import { prepareProviderSettingsForCli } from './hydrate';
import { ProviderErrorV1Schema } from '@happier-dev/protocol/providers/errors';
import { DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } from '@happier-dev/protocol/providers/connections/connectionRowsV1';
import { getActiveAccountSettingsSnapshot, setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import * as persistence from '@/persistence';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
        .toThrow(expect.objectContaining({ code: 'provider_catalog_unavailable' }));
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


afterEach(() => { vi.restoreAllMocks(); resetActiveAccountSettingsSnapshotForTests(); });
it.each(['ready', 'unreachable'] as const)('prepares cold direct-purpose settings and preserves catalog settlement: %s', async outcome => {
  const credentials = { token: 'catalog-auth-cold-fixture', encryption: null };
  vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(credentials);
  setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {},
    scopeKey: resolveAccountSettingsScopeKey(credentials), settingsVersion: 1, loadedAtMs: 1, settingsSecretsReadKeys: [] });
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const rowEntered = new Promise<void>(resolve => { entered = resolve; });
  let rows = 0;
  vi.spyOn(axios, 'get').mockImplementation(async url => {
    const path = new URL(String(url)).pathname;
    if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode: 'plain', version: 1,
      settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
    if (path === '/v1/account/entity-rows/provider-connections') {
      rows++; entered(); await held;
      return outcome === 'ready' ? { status: 200, data: { status: 'present', revision: 7,
        content: { t: 'plain', v: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } } } : { status: 503, data: { error: 'unreachable' } };
    }
    throw new Error('Unexpected catalog preparation boundary: ' + path);
  });
  let settled = false;
  const pending = prepareProviderSettingsForCli({ readSnapshot: getActiveAccountSettingsSnapshot })
    .then(settings => { settled = true; return { settings }; }, error => { settled = true; return { error }; });
  await rowEntered;
  expect(settled).toBe(false);
  release();
  const result = await pending;
  if (outcome === 'ready') {
    expect(result).toEqual({ settings: DEFAULT_PROVIDER_SETTINGS_V1 });
    expect(await prepareProviderSettingsForCli({ readSnapshot: getActiveAccountSettingsSnapshot })).toEqual(DEFAULT_PROVIDER_SETTINGS_V1);
  } else {
    expect(result).toMatchObject({ error: { code: 'provider_catalog_unavailable', failureCause: {
      phase: 'providers.catalog', errorCode: 'unreachable' } } });
    if (!('error' in result)) throw new Error('Expected typed catalog refusal');
    expect(ProviderErrorV1Schema.safeParse(result.error).success).toBe(true);
  }
  expect(rows).toBe(1);
});

it('consumes a retained ready catalog without borrowing ambient Account authority', async () => {
  const readCredentials = vi.spyOn(persistence, 'readStoredCredentials');
  const snapshot = { source: 'network' as const, settings: accountSettingsParse({}), rawSettings: {},
    settingsVersion: 1, loadedAtMs: 1, scopeKey: 'retained-account', settingsSecretsReadKeys: [],
    providerConnectionsCatalog: { status: 'ready' as const, revision: 7, catalog: DEFAULT_PROVIDER_CONNECTIONS_CATALOG_V1 } };
  expect(await prepareProviderSettingsForCli({ readSnapshot: () => snapshot })).toEqual(DEFAULT_PROVIDER_SETTINGS_V1);
  expect(readCredentials).not.toHaveBeenCalled();
});
