import { describe, expect, it } from 'vitest';

import { serializeModelVisibilityRefV1 } from '../selection/v1.js';
import {
  DEFAULT_PROVIDER_SETTINGS_V1,
  ProviderSettingsLimitError,
  ProviderSettingsV1Schema,
  assertProviderSettingsV1WithinLimits,
  parseProviderSettingsV1Narrow,
} from './v1.js';

function connection(id: string, contributionKey = 'happier.provider.openrouter:providers:openrouter') {
  return {
    v: 1,
    id,
    source: { kind: 'contribution', contributionKey },
    role: 'default',
    displayName: 'OpenRouter',
    displayNameMode: 'automatic',
    revision: 0,
    createdAt: 1,
    updatedAt: 1,
  } as const;
}

function validSettings() {
  const modelVisibilityKey = serializeModelVisibilityRefV1({
    scope: 'agent', agentTargetKey: 'agent:codex', providerConnectionId: 'pc_1', modelId: 'model/a',
  });
  return {
    ...DEFAULT_PROVIDER_SETTINGS_V1,
    connections: [connection('pc_1')],
    accountGrants: [{
      v: 1, connectionId: 'pc_1', connectionSecurityFingerprint: 'connection-security:v1:test', confirmedAt: 1,
    }],
    secretBindingsByConnectionId: { pc_1: { account: { apiKey: 'saved-secret-1' } } },
    manualModelsByConnectionId: { pc_1: [{ id: 'model/a', name: 'Model A', addedAt: 1 }] },
    modelVisibilityByRef: { [modelVisibilityKey]: 'hidden' },
    experimentalBindingConfirmations: [{
      v: 1, connectionId: 'pc_1', agentTargetKey: 'agent:codex', modelId: 'model/a',
      compatibilityFingerprint: 'compatibility:v1:test', confirmedAt: 1,
    }],
    defaultsByAgentTargetKey: {
      'agent:codex': { v: 1, ref: { agentTargetKey: 'agent:codex', providerConnectionId: 'pc_1', modelId: 'model/a' }, updatedAt: 1 },
    },
  } as const;
}

describe('ProviderSettingsV1Schema', () => {
  it('round-trips one coherent synced owner', () => {
    expect(ProviderSettingsV1Schema.parse(validSettings())).toEqual(validSettings());
  });

  it('rejects duplicate defaults, invalid cross-references and executable tombstones', () => {
    const duplicate = structuredClone(validSettings()) as any;
    duplicate.connections.push({ ...connection('pc_2'), id: 'pc_2' });
    expect(ProviderSettingsV1Schema.safeParse(duplicate).success).toBe(false);

    const badGrant = structuredClone(validSettings()) as any;
    badGrant.accountGrants[0].connectionId = 'missing';
    expect(ProviderSettingsV1Schema.safeParse(badGrant).success).toBe(false);

    const badTombstone = structuredClone(validSettings()) as any;
    badTombstone.connectionTombstones.push({
      v: 1, id: 'pc_1', contributionKey: null, lastDisplayName: 'Old', deletedAt: 2, baseUrl: 'https://secret.example',
    });
    expect(ProviderSettingsV1Schema.safeParse(badTombstone).success).toBe(false);
  });

  it('parses malformed siblings narrowly without erasing valid records', () => {
    const raw = structuredClone(validSettings()) as any;
    raw.connections.push({ v: 1, id: '', source: null });
    raw.accountGrants.push({ connectionId: 'missing' });
    const parsed = parseProviderSettingsV1Narrow(raw);
    expect(parsed.settings.connections.map((entry) => entry.id)).toEqual(['pc_1']);
    expect(parsed.settings.accountGrants).toHaveLength(1);
    expect(parsed.diagnostics.map((entry) => entry.path)).toContain('connections[1]');
  });

  it('enforces per-field limits and the decoded 4 MiB subtree budget atomically', () => {
    const oversized = structuredClone(validSettings()) as any;
    oversized.connections = Array.from({ length: 257 }, (_, index) => ({
      ...connection(`pc_${index}`, `plugin:providers:provider-${index}`), id: `pc_${index}`,
    }));
    expect(() => assertProviderSettingsV1WithinLimits(oversized)).toThrow(ProviderSettingsLimitError);

    const overBytes = structuredClone(validSettings()) as any;
    overBytes.connections[0].displayName = 'x'.repeat(4 * 1024 * 1024);
    expect(() => assertProviderSettingsV1WithinLimits(overBytes)).toThrow(ProviderSettingsLimitError);
  });

  it('maps every explicit nested count cap to the stable settings-limit error', () => {
    const atBounds = structuredClone(validSettings()) as any;
    atBounds.manualModelsByConnectionId.pc_1 = Array.from({ length: 500 }, (_, index) => ({ id: `m-${index}`, addedAt: 1 }));
    atBounds.secretBindingsByConnectionId.pc_1.account = Object.fromEntries(
      Array.from({ length: 8 }, (_, index) => [`slot-${index}`, `secret-${index}`]),
    );
    atBounds.secretBindingsByConnectionId.pc_1.byMachineId = Object.fromEntries(
      Array.from({ length: 2_048 }, (_, index) => [`machine-${index}`, { apiKey: `secret-${index}` }]),
    );
    atBounds.defaultsByAgentTargetKey = Object.fromEntries(Array.from({ length: 2_048 }, (_, index) => {
      const agentTargetKey = `agent:${index}`;
      return [agentTargetKey, {
        v: 1, ref: { agentTargetKey, providerConnectionId: null, modelId: 'native' }, updatedAt: 1,
      }];
    }));
    atBounds.migration = {
      v: 1,
      completedSources: Array.from({ length: 2_048 }, (_, index) => ({
        sourceProfileId: `completed-${index}`, kind: 'default_environment',
      })),
      pendingCustomProfileIds: Array.from({ length: 2_048 }, (_, index) => `pending-${index}`),
      migratedAt: 1,
    };
    expect(() => assertProviderSettingsV1WithinLimits(atBounds)).not.toThrow();

    const overCases = [
      (() => { const value = structuredClone(atBounds); value.manualModelsByConnectionId.pc_1.push({ id: 'over', addedAt: 1 }); return value; })(),
      (() => { const value = structuredClone(atBounds); value.secretBindingsByConnectionId.pc_1.account['slot-over'] = 'secret-over'; return value; })(),
      (() => { const value = structuredClone(atBounds); value.secretBindingsByConnectionId.pc_1.byMachineId['machine-over'] = { apiKey: 'secret-over' }; return value; })(),
      (() => { const value = structuredClone(atBounds); value.defaultsByAgentTargetKey['agent:over'] = { v: 1, ref: { agentTargetKey: 'agent:over', providerConnectionId: null, modelId: 'native' }, updatedAt: 1 }; return value; })(),
      (() => { const value = structuredClone(atBounds); value.migration.completedSources.push({ sourceProfileId: 'completed-over', kind: 'default_environment' }); return value; })(),
      (() => { const value = structuredClone(atBounds); value.migration.pendingCustomProfileIds.push('pending-over'); return value; })(),
    ];
    for (const value of overCases) {
      expect(() => assertProviderSettingsV1WithinLimits(value)).toThrowError(ProviderSettingsLimitError);
    }

    const totalManualOver = structuredClone(DEFAULT_PROVIDER_SETTINGS_V1) as any;
    totalManualOver.connections = Array.from({ length: 11 }, (_, index) =>
      ({ ...connection(`pc_${index}`, `plugin:providers:p-${index}`), role: 'named', displayNameMode: 'custom' }));
    totalManualOver.manualModelsByConnectionId = Object.fromEntries(totalManualOver.connections.map((entry: { id: string }, index: number) => [
      entry.id,
      Array.from({ length: index === 10 ? 1 : 500 }, (_, modelIndex) => ({ id: `m-${index}-${modelIndex}`, addedAt: 1 })),
    ]));
    expect(() => assertProviderSettingsV1WithinLimits(totalManualOver)).toThrowError(ProviderSettingsLimitError);
  });

  it('does not mislabel semantic schema failures as settings-limit errors', () => {
    const invalid = structuredClone(validSettings()) as any;
    invalid.accountGrants[0].connectionId = 'missing';
    try {
      assertProviderSettingsV1WithinLimits(invalid);
      throw new Error('Expected semantic validation to fail');
    } catch (error) {
      expect(error).not.toBeInstanceOf(ProviderSettingsLimitError);
    }
  });

  it('maps endpoint-override machine-branch overflow to the shared limit and narrow-read diagnostic', () => {
    const over = structuredClone(validSettings()) as any;
    over.connections[0].endpointOverridesByMachineId = Object.fromEntries(
      Array.from({ length: 2_049 }, (_, index) => [`machine-${index}`, []]),
    );
    expect(() => assertProviderSettingsV1WithinLimits(over)).toThrowError(ProviderSettingsLimitError);
    const recovered = parseProviderSettingsV1Narrow(over);
    expect(recovered.settings.connections).toEqual([]);
    expect(recovered.diagnostics).toContainEqual({ path: 'connections[0]', reason: 'invalid_record' });
  });

  it('keeps account and per-machine secret binding precedence explicit', () => {
    const settings = structuredClone(validSettings()) as any;
    settings.secretBindingsByConnectionId.pc_1.byMachineId = {
      machine_a: { apiKey: 'machine-secret' },
    };
    expect(ProviderSettingsV1Schema.parse(settings).secretBindingsByConnectionId.pc_1).toEqual({
      account: { apiKey: 'saved-secret-1' },
      byMachineId: { machine_a: { apiKey: 'machine-secret' } },
    });
  });

  it('diagnoses deterministic duplicate recovery instead of silently dropping semantic records', () => {
    const raw = structuredClone(validSettings()) as any;
    raw.accountGrants.push({ ...raw.accountGrants[0] });
    raw.machineGrants = [
      { v: 1, machineId: 'machine_a', connectionId: 'pc_1', endpointSetFingerprint: 'endpoint-set:v1:a', connectionSecurityFingerprint: 'connection-security:v1:a', confirmedAt: 1 },
      { v: 1, machineId: 'machine_a', connectionId: 'pc_1', endpointSetFingerprint: 'endpoint-set:v1:b', connectionSecurityFingerprint: 'connection-security:v1:b', confirmedAt: 2 },
    ];
    raw.connectionTombstones = [
      { v: 1, id: 'deleted', contributionKey: null, lastDisplayName: 'Old', deletedAt: 1 },
      { v: 1, id: 'deleted', contributionKey: null, lastDisplayName: 'New', deletedAt: 2 },
    ];
    raw.manualModelsByConnectionId.pc_1.push({ ...raw.manualModelsByConnectionId.pc_1[0], name: 'Duplicate' });
    raw.experimentalBindingConfirmations.push({ ...raw.experimentalBindingConfirmations[0] });

    const parsed = parseProviderSettingsV1Narrow(raw);
    expect(parsed.settings.accountGrants).toHaveLength(1);
    expect(parsed.settings.machineGrants).toHaveLength(1);
    expect(parsed.settings.connectionTombstones).toHaveLength(1);
    expect(parsed.settings.manualModelsByConnectionId.pc_1).toHaveLength(1);
    expect(parsed.settings.experimentalBindingConfirmations).toHaveLength(1);
    expect(parsed.diagnostics.filter((entry) => entry.reason === 'duplicate_identity')).toHaveLength(5);
  });

  it('diagnoses read-recovery truncation at hard caps while retaining the first valid records', () => {
    const raw = structuredClone(DEFAULT_PROVIDER_SETTINGS_V1) as any;
    raw.connections = Array.from({ length: 257 }, (_, index) => connection(`pc_${index}`, `plugin:providers:p-${index}`));
    const parsed = parseProviderSettingsV1Narrow(raw);
    expect(parsed.settings.connections).toHaveLength(256);
    expect(parsed.diagnostics).toContainEqual({ path: 'connections', reason: 'limit_exceeded' });
  });

  it('rejects non-canonical map keys before they can overwrite canonical bindings', () => {
    const cases: unknown[] = [];

    const connectionKeys = structuredClone(validSettings()) as any;
    connectionKeys.secretBindingsByConnectionId[' pc_1 '] = { account: { apiKey: 'attacker-secret' } };
    cases.push(connectionKeys);

    const machineKeys = structuredClone(validSettings()) as any;
    machineKeys.secretBindingsByConnectionId.pc_1.byMachineId = {
      machine_a: { apiKey: 'machine-secret' },
      ' machine_a ': { apiKey: 'attacker-secret' },
    };
    cases.push(machineKeys);

    const slotKeys = structuredClone(validSettings()) as any;
    slotKeys.secretBindingsByConnectionId.pc_1.account = {
      apiKey: 'saved-secret-1',
      ' apiKey ': 'attacker-secret',
    };
    cases.push(slotKeys);

    const defaultKeys = structuredClone(validSettings()) as any;
    defaultKeys.defaultsByAgentTargetKey[' agent:codex '] = {
      ...defaultKeys.defaultsByAgentTargetKey['agent:codex'],
      ref: { ...defaultKeys.defaultsByAgentTargetKey['agent:codex'].ref, modelId: 'wrong-model' },
    };
    cases.push(defaultKeys);

    for (const value of cases) expect(ProviderSettingsV1Schema.safeParse(value).success).toBe(false);
  });

  it('records one bounded terminal migration outcome per source', () => {
    const valid = structuredClone(validSettings()) as any;
    valid.migration = {
      v: 1,
      completedSources: [
        { sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc_1' },
        { sourceProfileId: 'anthropic', kind: 'default_environment' },
      ],
      pendingCustomProfileIds: ['company-gateway'],
      migratedAt: 2,
    };
    expect(ProviderSettingsV1Schema.safeParse(valid).success).toBe(true);

    const duplicate = structuredClone(valid) as any;
    duplicate.migration.completedSources.push({ sourceProfileId: 'deepseek', kind: 'default_environment' });
    expect(ProviderSettingsV1Schema.safeParse(duplicate).success).toBe(false);

    const missing = structuredClone(valid) as any;
    missing.migration.completedSources[0].connectionId = 'pc_missing';
    expect(ProviderSettingsV1Schema.safeParse(missing).success).toBe(true);

    const contradictory = structuredClone(valid) as any;
    contradictory.migration.pendingCustomProfileIds.push('deepseek');
    expect(ProviderSettingsV1Schema.safeParse(contradictory).success).toBe(false);
  });

  it('retains historical connection outcomes while diagnosing contradictory pending state', () => {
    const raw = structuredClone(validSettings()) as any;
    raw.migration = {
      v: 1,
      completedSources: [
        { sourceProfileId: 'missing-profile', kind: 'connection', connectionId: 'pc_missing' },
        { sourceProfileId: 'native-login', kind: 'default_environment' },
      ],
      pendingCustomProfileIds: ['native-login', 'pending-valid'],
      migratedAt: 2,
    };
    expect(() => parseProviderSettingsV1Narrow(raw)).not.toThrow();
    const parsed = parseProviderSettingsV1Narrow(raw);
    expect(parsed.settings.migration).toEqual({
      v: 1,
      completedSources: [
        { sourceProfileId: 'missing-profile', kind: 'connection', connectionId: 'pc_missing' },
        { sourceProfileId: 'native-login', kind: 'default_environment' },
      ],
      pendingCustomProfileIds: ['pending-valid'],
      migratedAt: 2,
    });
    expect(parsed.diagnostics).toContainEqual({
      path: 'migration.pendingCustomProfileIds[0]', reason: 'already_completed',
    });
  });
});
