import { describe, expect, it } from 'vitest';

import { serializeModelVisibilityRefV1 } from '../selection/v1.js';
import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  PROVIDER_SETTINGS_LIMITS_V1,
  ProviderSettingsLimitError,
  ProviderSettingsV1Schema,
} from './v1.js';
import {
  addOrUpdateProviderManualModelV1,
  addOrUpdateProviderManualModelsV1,
  deleteProviderConnectionV1,
  ensureDefaultProviderConnectionV1,
  removeProviderMachineStateV1,
  resolveProviderGrantV1,
  resolveProviderSecretBindingIdV1,
  removeProviderManualModelV1,
  resetProviderModelVisibilityV1,
  setProviderExperimentalConfirmationV1,
  setProviderModelVisibilityV1,
} from './operationsV1.js';

function baseSettings() {
  const connection = {
    v: 1, id: 'pc_a', source: { kind: 'contribution', contributionKey: 'plugin:providers:p' },
    role: 'default', displayName: 'P', displayNameMode: 'automatic',
    endpointOverridesByMachineId: {
      machine_a: [{ endpointTemplateId: 'chat', baseUrl: 'http://127.0.0.1:1234/' }],
      machine_b: [{ endpointTemplateId: 'chat', baseUrl: 'http://127.0.0.1:5678/' }],
    },
    revision: 0, createdAt: 1, updatedAt: 1,
  } as const;
  const visibility = serializeModelVisibilityRefV1({
    scope: 'allAgents', providerConnectionId: 'pc_a', modelId: 'model-a',
  });
  return ProviderSettingsV1Schema.parse({
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [connection],
    accountGrants: [{ v: 1, connectionId: 'pc_a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1 }],
    machineGrants: [
      { v: 1, machineId: 'machine_a', connectionId: 'pc_a', endpointSetFingerprint: 'endpoint-set:v1:a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1 },
      { v: 1, machineId: 'machine_b', connectionId: 'pc_a', endpointSetFingerprint: 'endpoint-set:v1:b', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1 },
    ],
    secretBindingsByConnectionId: {
      pc_a: { account: { apiKey: 'secret-account' }, byMachineId: { machine_a: { apiKey: 'secret-a' }, machine_b: { apiKey: 'secret-b' } } },
    },
    manualModelsByConnectionId: { pc_a: [{ id: 'model-a', addedAt: 1 }] },
    modelVisibilityByRef: { [visibility]: 'hidden' },
    experimentalBindingConfirmations: [{
      v: 1, connectionId: 'pc_a', agentTargetKey: 'agent:codex', modelId: 'model-a',
      compatibilityFingerprint: 'compatibility:v1:a', confirmedAt: 1,
    }],
    defaultsByAgentTargetKey: {
      'agent:codex': { v: 1, ref: { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_a', modelId: 'model-a' }, updatedAt: 1 },
    },
    migration: {
      v: 1,
      completedSources: [{ sourceProfileId: 'legacy-p', kind: 'connection', connectionId: 'pc_a' }],
      pendingCustomProfileIds: [], migratedAt: 1,
    },
  });
}

describe('provider settings operations', () => {
  it('adds a manual-model batch atomically when the final settings would exceed the connection limit', () => {
    const original = ProviderSettingsV1Schema.parse({
      ...baseSettings(),
      manualModelsByConnectionId: {
        pc_a: Array.from({ length: PROVIDER_SETTINGS_LIMITS_V1.manualModelsPerConnection - 1 }, (_, index) => ({
          id: `existing-${index}`,
          addedAt: 1,
        })),
      },
    });

    expect(() => addOrUpdateProviderManualModelsV1(original, {
      connectionId: 'pc_a',
      models: [{ id: 'new-a' }, { id: 'new-b' }],
      addedAt: 10,
    })).toThrowError(ProviderSettingsLimitError);
    expect(original.manualModelsByConnectionId.pc_a).toHaveLength(
      PROVIDER_SETTINGS_LIMITS_V1.manualModelsPerConnection - 1,
    );
    expect(original.manualModelsByConnectionId.pc_a?.some((model) => model.id.startsWith('new-'))).toBe(false);
  });

  it('mutates manual models, exact visibility, and fingerprint-bound confirmations without parallel settings owners', () => {
    const base = baseSettings();
    const withManual = addOrUpdateProviderManualModelV1(base, {
      connectionId: 'pc_a', model: { id: 'org/model', name: 'Model' }, addedAt: 10,
    });
    expect(withManual.manualModelsByConnectionId.pc_a).toContainEqual({ id: 'org/model', name: 'Model', addedAt: 10 });
    const updated = addOrUpdateProviderManualModelV1(withManual, {
      connectionId: 'pc_a', model: { id: 'org/model', name: 'Renamed' }, addedAt: 11,
    });
    expect(updated.manualModelsByConnectionId.pc_a?.filter((model) => model.id === 'org/model'))
      .toEqual([{ id: 'org/model', name: 'Renamed', addedAt: 10 }]);

    const visibilityRef = {
      scope: 'agent' as const, agentTargetKey: 'backend:codex',
      providerConnectionId: 'pc_a', modelId: 'org/model',
    };
    const hidden = setProviderModelVisibilityV1(updated, { ref: visibilityRef, hidden: true });
    expect(hidden.modelVisibilityByRef[serializeModelVisibilityRefV1(visibilityRef)]).toBe('hidden');
    const visible = setProviderModelVisibilityV1(hidden, { ref: visibilityRef, hidden: false });
    expect(visible.modelVisibilityByRef[serializeModelVisibilityRefV1(visibilityRef)]).toBeUndefined();

    const confirmed = setProviderExperimentalConfirmationV1(visible, {
      connectionId: 'pc_a', agentTargetKey: 'backend:codex', modelId: 'org/model',
      compatibilityFingerprint: 'compatibility:v1:abc', confirmedAt: 20,
    });
    expect(confirmed.experimentalBindingConfirmations).toContainEqual({
      v: 1, connectionId: 'pc_a', agentTargetKey: 'backend:codex', modelId: 'org/model',
      compatibilityFingerprint: 'compatibility:v1:abc', confirmedAt: 20,
    });
    expect(removeProviderManualModelV1(confirmed, { connectionId: 'pc_a', modelId: 'org/model' })
      .manualModelsByConnectionId.pc_a).toEqual([{ id: 'model-a', addedAt: 1 }]);
  });

  it('resets only the requested visibility scope and rejects unknown connection references atomically', () => {
    const native = serializeModelVisibilityRefV1({
      scope: 'agent', agentTargetKey: 'backend:codex', providerConnectionId: null, modelId: 'native',
    });
    const providerAgent = serializeModelVisibilityRefV1({
      scope: 'agent', agentTargetKey: 'backend:codex', providerConnectionId: 'pc_a', modelId: 'provider',
    });
    const providerAll = serializeModelVisibilityRefV1({
      scope: 'allAgents', providerConnectionId: 'pc_a', modelId: 'provider',
    });
    const initial = ProviderSettingsV1Schema.parse({
      ...baseSettings(), modelVisibilityByRef: { [native]: 'hidden', [providerAgent]: 'hidden', [providerAll]: 'hidden' },
    });
    expect(resetProviderModelVisibilityV1(initial, {
      scope: { kind: 'agent', agentTargetKey: 'backend:codex' },
    }).modelVisibilityByRef).toEqual({ [providerAll]: 'hidden' });
    expect(resetProviderModelVisibilityV1(initial, {
      scope: { kind: 'connection', connectionId: 'pc_a' },
    }).modelVisibilityByRef).toEqual({ [native]: 'hidden' });
    expect(() => setProviderModelVisibilityV1(initial, {
      ref: { scope: 'allAgents', providerConnectionId: 'missing', modelId: 'm' }, hidden: true,
    })).toThrow();
  });
  it('CAS-reuses the winning default connection rather than duplicating it', () => {
    const existing = baseSettings();
    const result = ensureDefaultProviderConnectionV1(existing, {
      contributionKey: 'plugin:providers:p', allocatedConnectionId: 'pc_loser',
      providerName: 'P', now: 2,
    });
    expect(result.changed).toBe(false);
    expect(result.connection.id).toBe('pc_a');

    const created = ensureDefaultProviderConnectionV1(DEFAULT_PROVIDER_SETTINGS_V1, {
      contributionKey: 'plugin:providers:new', allocatedConnectionId: 'pc_new',
      providerName: 'New', now: 2,
    });
    expect(created.changed).toBe(true);
    expect(created.connection).toMatchObject({ id: 'pc_new', role: 'default', displayNameMode: 'automatic' });
  });

  it('requires the exact grant type and fingerprints for the resolved scope', () => {
    const settings = baseSettings();
    expect(resolveProviderGrantV1(settings, {
      scope: 'account', connectionId: 'pc_a', machineId: 'machine_a',
      connectionSecurityFingerprint: 'connection-security:v1:a', endpointSetFingerprint: 'ignored',
    })).toEqual({ authorized: true, grantKind: 'account' });
    expect(resolveProviderGrantV1(settings, {
      scope: 'machine', connectionId: 'pc_a', machineId: 'machine_a',
      connectionSecurityFingerprint: 'connection-security:v1:a', endpointSetFingerprint: 'endpoint-set:v1:changed',
    })).toEqual({ authorized: false, errorCode: 'provider_machine_grant_stale' });
  });

  it('resolves per-machine secrets before account bindings without mutating either', () => {
    const settings = baseSettings();
    expect(resolveProviderSecretBindingIdV1(settings, 'pc_a', 'machine_a', 'apiKey')).toBe('secret-a');
    expect(resolveProviderSecretBindingIdV1(settings, 'pc_a', 'machine_missing', 'apiKey')).toBe('secret-account');
  });

  it('never resolves inherited or poison credential-slot properties', () => {
    const settings = baseSettings();
    for (const slotId of ['__proto__', 'constructor', 'prototype']) {
      expect(() => resolveProviderSecretBindingIdV1(settings, 'pc_a', 'machine_a', slotId)).toThrow();
    }
    expect(resolveProviderSecretBindingIdV1(settings, 'pc_a', 'machine_a', 'toString')).toBeNull();
    expect(resolveProviderSecretBindingIdV1(settings, 'pc_a', 'machine_missing', 'valueOf')).toBeNull();
  });

  it('removes only one machine override, grant, and machine-secret branch', () => {
    const next = removeProviderMachineStateV1(baseSettings(), 'machine_a');
    expect(next.machineGrants.map((grant) => grant.machineId)).toEqual(['machine_b']);
    expect(next.connections[0]?.endpointOverridesByMachineId).toEqual({
      machine_b: [{ endpointTemplateId: 'chat', baseUrl: 'http://127.0.0.1:5678/' }],
    });
    expect(next.secretBindingsByConnectionId.pc_a).toEqual({
      account: { apiKey: 'secret-account' }, byMachineId: { machine_b: { apiKey: 'secret-b' } },
    });
  });

  it('deletes executable state but retains a minimal tombstone and migration provenance', () => {
    const next = deleteProviderConnectionV1(baseSettings(), 'pc_a', 5);
    expect(next.connections).toEqual([]);
    expect(next.accountGrants).toEqual([]);
    expect(next.machineGrants).toEqual([]);
    expect(next.secretBindingsByConnectionId).toEqual({});
    expect(next.manualModelsByConnectionId).toEqual({});
    expect(next.modelVisibilityByRef).toEqual({});
    expect(next.defaultsByAgentTargetKey).toEqual({});
    expect(next.connectionTombstones).toEqual([{
      v: 1, id: 'pc_a', contributionKey: 'plugin:providers:p', lastDisplayName: 'P', deletedAt: 5,
    }]);
    expect(next.migration?.completedSources).toEqual([
      { sourceProfileId: 'legacy-p', kind: 'connection', connectionId: 'pc_a' },
    ]);
  });

  it('deletes atomically at the tombstone cap and deterministically prunes the oldest tombstone', () => {
    const tombstones = Array.from({ length: PROVIDER_SETTINGS_LIMITS_V1.connectionTombstones }, (_, index) => ({
      v: 1 as const,
      id: `pc_deleted_${String(index).padStart(3, '0')}`,
      contributionKey: null,
      lastDisplayName: `Deleted ${index}`,
      deletedAt: index < 2 ? 1 : index,
    }));
    const settings = ProviderSettingsV1Schema.parse({ ...baseSettings(), connectionTombstones: tombstones });

    const next = deleteProviderConnectionV1(settings, 'pc_a', 500);

    expect(next.connections).toEqual([]);
    expect(next.accountGrants).toEqual([]);
    expect(next.machineGrants).toEqual([]);
    expect(next.secretBindingsByConnectionId).toEqual({});
    expect(next.connectionTombstones).toHaveLength(PROVIDER_SETTINGS_LIMITS_V1.connectionTombstones);
    expect(next.connectionTombstones.some((entry) => entry.id === 'pc_a')).toBe(true);
    expect(next.connectionTombstones.some((entry) => entry.id === 'pc_deleted_000')).toBe(false);
    expect(next.connectionTombstones.some((entry) => entry.id === 'pc_deleted_001')).toBe(true);
  });

  it('reports a stable domain limit error when default creation would exceed the connection cap', () => {
    const connections = Array.from({ length: PROVIDER_SETTINGS_LIMITS_V1.connections }, (_, index) => ({
      v: 1 as const,
      id: `pc_existing_${String(index).padStart(3, '0')}`,
      source: { kind: 'contribution' as const, contributionKey: `plugin:providers:p-${index}` },
      role: 'default' as const,
      displayName: `Provider ${index}`,
      displayNameMode: 'automatic' as const,
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
    }));
    const settings = ProviderSettingsV1Schema.parse({ ...DEFAULT_PROVIDER_SETTINGS_V1, connections });

    expect(() => ensureDefaultProviderConnectionV1(settings, {
      contributionKey: 'plugin:providers:overflow',
      allocatedConnectionId: 'pc_overflow',
      providerName: 'Overflow',
      now: 2,
    })).toThrowError(ProviderSettingsLimitError);
  });

  it('uses the canonical decoded-size owner for additive connection mutations', () => {
    const connections = Array.from({ length: 10 }, (_, index) => ({
      v: 1 as const,
      id: `pc_large_${index}`,
      source: { kind: 'contribution' as const, contributionKey: `plugin:providers:large-${index}` },
      role: 'named' as const,
      displayName: `Large ${index}`,
      displayNameMode: 'custom' as const,
      revision: 0,
      createdAt: 1,
      updatedAt: 1,
    }));
    const manualModelsByConnectionId = Object.fromEntries(connections.map((connection, connectionIndex) => [
      connection.id,
      Array.from({ length: 500 }, (_, modelIndex) => {
        const suffix = `-${connectionIndex}-${modelIndex}`;
        return { id: `${'é'.repeat(512 - suffix.length)}${suffix}`, name: 'N'.repeat(256), addedAt: 1 };
      }),
    ]));
    const schemaValidButOversized = ProviderSettingsV1Schema.parse({
      ...DEFAULT_PROVIDER_SETTINGS_V1, connections, manualModelsByConnectionId,
    });

    expect(() => ensureDefaultProviderConnectionV1(schemaValidButOversized, {
      contributionKey: 'plugin:providers:new', allocatedConnectionId: 'pc_new', providerName: 'New', now: 2,
    })).toThrowError(ProviderSettingsLimitError);
  });
});
