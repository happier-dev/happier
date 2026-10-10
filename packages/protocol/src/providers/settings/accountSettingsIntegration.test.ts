import { describe, expect, it } from 'vitest';

import {
  accountSettingsParse,
} from '../../account/settings/accountSettings.js';
import { serializeModelVisibilityRefV1 } from '../selection/v1.js';
import { readRetainedProviderConnectionsCatalogV1 } from '../connections/connectionRowsV1.js';
import {
  ProviderSettingsLimitError,
  ProviderSettingsV1Schema,
  assertProviderSettingsV1WithinLimits,
} from './v1.js';
import { ACCOUNT_SETTINGS_MAX_PROVIDER_SUBTREE_BYTES } from '../../account/settings/catalog/accountSettingBounds.js';

const connection = {
  v: 1,
  id: 'pc_1',
  source: { kind: 'contribution', contributionKey: 'plugin/p' },
  role: 'default',
  displayName: 'P',
  displayNameMode: 'automatic',
  revision: 0,
  createdAt: 1,
  updatedAt: 1,
} as const;

describe('provider account settings integration', () => {
  it.each([6, 7])('preserves outer schema v%s and an absent provider subtree without provider-owned rewrites', (schemaVersion) => {
    const parsed = accountSettingsParse({ schemaVersion, xFuture: { preserved: true } });
    expect(parsed.schemaVersion).toBe(schemaVersion);
    expect(parsed.providerSettingsV1).toBeUndefined();
    expect(parsed.xFuture).toEqual({ preserved: true });
  });

  it('keeps future and malformed Provider source outside active Account preferences and refuses its transfer', () => {
    const cases = [
      { schemaVersion: 7, providerSettingsV1: { v: 2, opaque: { preserve: true } }, unrelated: 'x' },
      { schemaVersion: 6, providerSettingsV1: { v: 'bad', malformed: ['preserve'] }, unrelated: 'y' },
    ];
    for (const raw of cases) {
      const retained = structuredClone(raw);
      const parsed = accountSettingsParse(raw);
      expect(parsed.providerSettingsV1).toBeUndefined();
      expect(accountSettingsParse({ ...parsed, unrelated: `${raw.unrelated}-changed` }).providerSettingsV1)
        .toBeUndefined();
      expect(readRetainedProviderConnectionsCatalogV1(raw)).toMatchObject({ status: 'unavailable' });
      expect(raw).toEqual(retained);
    }
  });

  it('retains valid provider siblings through the canonical diagnostic reader when one record is malformed', () => {
    const visibility = serializeModelVisibilityRefV1({
      scope: 'agent', agentTargetKey: 'agent:codex', providerConnectionId: 'pc_1', modelId: 'x',
    });
    const raw = {
      schemaVersion: 7,
      providerSettingsV1: {
        v: 1,
        connections: [connection, { v: 1, id: '' }],
        connectionTombstones: [], accountGrants: [], machineGrants: [],
        secretBindingsByConnectionId: {}, manualModelsByConnectionId: {},
        modelVisibilityByRef: { [visibility]: 'hidden' },
        experimentalBindingConfirmations: [], defaultsByAgentTargetKey: {},
      },
    };
    const parsed = accountSettingsParse(raw);
    expect(parsed.providerSettingsV1).toBeUndefined();
    const provider = readRetainedProviderConnectionsCatalogV1(raw);
    expect(provider.status).toBe('partial');
    if (provider.status !== 'partial') throw new Error('Expected the canonical retained-source diagnostic');
    expect(provider.catalog.connections.map((entry) => entry.id)).toEqual(['pc_1']);
    expect(provider.catalog.modelVisibilityByRef).toEqual({ [visibility]: 'hidden' });
    expect(provider.diagnostics).toContainEqual({ path: 'connections[1]', reason: 'invalid_record' });
  });

  it('preserves a Provider-valid subtree whose cardinality exceeds the generic Account node policy', () => {
    // Provider settings own Provider cardinality: 500 manual models per connection.
    // Inactive source reads use Provider cardinality, not the active Account
    // preferences projection's generic node policy.
    const manualModels = Array.from({ length: 300 }, (_, index) => ({ id: `model-${index}`, addedAt: 1 }));
    const providerSettingsV1 = {
      v: 1,
      connections: [connection],
      connectionTombstones: [], accountGrants: [], machineGrants: [],
      secretBindingsByConnectionId: {},
      manualModelsByConnectionId: { pc_1: manualModels },
      modelVisibilityByRef: {},
      experimentalBindingConfirmations: [], defaultsByAgentTargetKey: {},
    };
    expect(ProviderSettingsV1Schema.safeParse(providerSettingsV1).success).toBe(true);

    const raw = { schemaVersion: 7, providerSettingsV1 };
    const parsed = accountSettingsParse(raw);
    expect(parsed.providerSettingsV1).toBeUndefined();

    const provider = readRetainedProviderConnectionsCatalogV1(raw);
    expect(provider.status).toBe('ready');
    if (provider.status !== 'ready') throw new Error('Expected complete retained-source authority');
    expect(provider.catalog.manualModelsByConnectionId.pc_1).toHaveLength(300);
  });

  it('refuses a Provider subtree larger than the Account-owned persistence ceiling instead of silently dropping it', () => {
    const oversized = {
      v: 1,
      connections: [connection],
      connectionTombstones: [], accountGrants: [], machineGrants: [],
      secretBindingsByConnectionId: {},
      manualModelsByConnectionId: {
        pc_1: Array.from({ length: 500 }, (_, index) => ({
          id: `model-${index}-${'z'.repeat(400)}`,
          name: 'n'.repeat(400),
          addedAt: 1,
        })),
      },
      modelVisibilityByRef: {},
      experimentalBindingConfirmations: [], defaultsByAgentTargetKey: {},
    };
    const bytes = new TextEncoder().encode(JSON.stringify(oversized)).byteLength;
    expect(bytes).toBeGreaterThan(ACCOUNT_SETTINGS_MAX_PROVIDER_SUBTREE_BYTES);

    // The Provider owner must advertise the same ceiling the Account document can persist,
    // so an oversized write is refused by Provider validation rather than acknowledged and lost.
    expect(() => assertProviderSettingsV1WithinLimits(oversized)).toThrow(ProviderSettingsLimitError);
  });
});
