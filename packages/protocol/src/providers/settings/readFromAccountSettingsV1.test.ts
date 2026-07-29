import { describe, expect, it } from 'vitest';

import { readProviderSettingsFromAccountSettingsV1 } from './readFromAccountSettingsV1.js';
import { DEFAULT_PROVIDER_SETTINGS_V1 } from './v1.js';

function defaultConnection(id: string, contributionKey: string) {
  return {
    v: 1 as const,
    id,
    source: { kind: 'contribution' as const, contributionKey },
    role: 'default' as const,
    displayName: 'Gateway',
    displayNameMode: 'automatic' as const,
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

describe('readProviderSettingsFromAccountSettingsV1', () => {
  it('returns defaults without diagnostics when the provider subtree is absent', () => {
    const result = readProviderSettingsFromAccountSettingsV1({ schemaVersion: 2, futureKey: true });
    expect(result.settings.connections).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  it('reads the canonical Provider key at the persisted read seam', () => {
    const raw = {
      providerSettingsV1: {
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [defaultConnection('pc_gateway', 'acme.gateway/gateway')],
      },
    };

    expect(readProviderSettingsFromAccountSettingsV1(raw)).toMatchObject({
      diagnostics: [],
      settings: {
        connections: [{
          id: 'pc_gateway',
          source: { kind: 'contribution', contributionKey: 'acme.gateway/gateway' },
        }],
      },
    });
  });

  it('deduplicates repeated canonical default keys as one persisted identity', () => {
    const raw = {
      providerSettingsV1: {
        ...DEFAULT_PROVIDER_SETTINGS_V1,
        connections: [
          defaultConnection('pc_first', 'acme.gateway/gateway'),
          defaultConnection('pc_canonical', 'acme.gateway/gateway'),
        ],
      },
    };

    const result = readProviderSettingsFromAccountSettingsV1(raw);
    expect(result.settings.connections).toEqual([
      expect.objectContaining({
        id: 'pc_first',
        source: { kind: 'contribution', contributionKey: 'acme.gateway/gateway' },
      }),
    ]);
    expect(result.diagnostics).toContainEqual({ path: 'connections', reason: 'duplicate_identity' });
  });

  it('retains valid siblings and exposes bounded diagnostics for malformed provider records', () => {
    const raw = {
      providerSettingsV1: {
        v: 1,
        connections: [
          {
            v: 1, id: 'pc_valid', source: { kind: 'contribution', contributionKey: 'plugin/p' },
            role: 'default', displayName: 'P', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1,
          },
          { v: 1, id: '', source: null },
        ],
        connectionTombstones: [], accountGrants: [], machineGrants: [],
        secretBindingsByConnectionId: {}, manualModelsByConnectionId: {}, modelVisibilityByRef: {},
        experimentalBindingConfirmations: [], defaultsByAgentTargetKey: {},
      },
    };
    const snapshot = structuredClone(raw);
    const result = readProviderSettingsFromAccountSettingsV1(raw);
    expect(result.settings.connections.map((entry) => entry.id)).toEqual(['pc_valid']);
    expect(result.diagnostics).toContainEqual({ path: 'connections[1]', reason: 'invalid_record' });
    expect(raw).toEqual(snapshot);
  });

  it('diagnoses a malformed account boundary without throwing or persisting a replacement', () => {
    const result = readProviderSettingsFromAccountSettingsV1('not-an-account-object');
    expect(result.settings.connections).toEqual([]);
    expect(result.diagnostics).toEqual([{ path: 'providerSettingsV1', reason: 'invalid_account_settings' }]);
  });

  it('preserves and diagnoses a future provider subtree instead of interpreting it as v1', () => {
    const raw = { schemaVersion: 7, providerSettingsV1: { v: 2, opaqueFutureState: { keep: true } } };
    const snapshot = structuredClone(raw);
    const result = readProviderSettingsFromAccountSettingsV1(raw);
    expect(result.settings).toEqual(expect.objectContaining({ v: 1, connections: [] }));
    expect(result.diagnostics).toEqual([{ path: 'providerSettingsV1', reason: 'unsupported_future_version' }]);
    expect(raw).toEqual(snapshot);
  });
});
