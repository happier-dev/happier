import { describe, expect, it } from 'vitest';

import { ACCOUNT_SETTINGS_MAX_PROVIDER_SUBTREE_BYTES } from '../../account/settings/catalog/accountSettingBounds.js';
import { serializeModelVisibilityRefV1 } from '../selection/v1.js';
import {
  SavedSecretSlotBindingsV1Schema,
  DEFAULT_PROVIDER_SETTINGS_V1,
  PROVIDER_SETTINGS_LIMITS_V1,
  ProviderSettingsLimitError,
  ProviderSettingsV1Schema,
  ProviderSettingsMigrationPendingConflictV1Schema,
  assertProviderSettingsV1WithinLimits,
  parseProviderSettingsV1Narrow,
} from './v1.js';

function connection(id: string, contributionKey = 'happier.provider.openrouter/openrouter') {
  return {
    v: 1,
    id,
    source: { kind: 'contribution', contributionKey },
    role: 'default',
    displayName: 'OpenRouter',
    displayNameMode: 'automatic',
    deployment: { kind: 'external' },
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

describe('SavedSecretSlotBindingsV1Schema', () => {
  it('validates the reusable account and per-machine slot-binding primitive', () => {
    expect(SavedSecretSlotBindingsV1Schema.parse({
      account: { api_key: 'saved-secret-account' },
      byMachineId: { machine_a: { api_key: 'saved-secret-machine' } },
    })).toEqual({
      account: { api_key: 'saved-secret-account' },
      byMachineId: { machine_a: { api_key: 'saved-secret-machine' } },
    });
    expect(SavedSecretSlotBindingsV1Schema.safeParse({
      account: { api_key: ' saved-secret' },
    }).success).toBe(false);
  });
});

describe('ProviderSettingsV1Schema', () => {
  it('round-trips one coherent synced owner', () => {
    expect(ProviderSettingsV1Schema.parse(validSettings())).toEqual(validSettings());
  });

  it('expands predecessor connections without deployment as external', () => {
    const settings = structuredClone(validSettings());
    const { deployment: _deployment, ...predecessorConnection } =
      settings.connections[0];
    settings.connections = [predecessorConnection] as typeof settings.connections;

    expect(
      ProviderSettingsV1Schema.parse(settings).connections[0]?.deployment,
    ).toEqual({ kind: 'external' });
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

  it('accepts valid connection records beyond the retired global count and advertises the Account-owned subtree budget', () => {
    const oversized = structuredClone(validSettings()) as any;
    oversized.connections = Array.from({ length: 257 }, (_, index) => ({
      ...connection(`pc_${index}`, `plugin/provider-${index}`), id: `pc_${index}`,
    }));
    expect(() => assertProviderSettingsV1WithinLimits(oversized)).not.toThrow();

    // The subtree is persisted inside the Account Settings document, so the advertised
    // maximum must be exactly what that document can hold for this root. Any larger
    // allowance produces writes this owner accepts and Account Settings then discards.
    expect(PROVIDER_SETTINGS_LIMITS_V1.decodedJsonBytes)
      .toBe(ACCOUNT_SETTINGS_MAX_PROVIDER_SUBTREE_BYTES);

    // The byte gate runs before schema validation, so an oversized subtree is reported as a
    // settings-limit refusal rather than an unrelated semantic failure.
    const overBytes = structuredClone(validSettings()) as any;
    overBytes.connections[0].displayName = 'x'.repeat(
      ACCOUNT_SETTINGS_MAX_PROVIDER_SUBTREE_BYTES + 1,
    );
    expect(() => assertProviderSettingsV1WithinLimits(overBytes)).toThrow(ProviderSettingsLimitError);
  });

  // Each nested cap is exercised on its own fixture: the caps are independent defensive
  // bounds on one node, not a joint allowance, and the Account-owned byte ceiling is the
  // outer bound every one of them shares.
  const nestedCountCaps: ReadonlyArray<Readonly<{
    label: string;
    atBound: (value: any) => void;
    over: (value: any) => void;
  }>> = [
    {
      label: 'manual models per connection',
      atBound: (value) => {
        value.manualModelsByConnectionId.pc_1 = Array.from({ length: 500 }, (_, index) => ({ id: `m-${index}`, addedAt: 1 }));
      },
      over: (value) => { value.manualModelsByConnectionId.pc_1.push({ id: 'over', addedAt: 1 }); },
    },
    {
      label: 'credential slots per scope',
      atBound: (value) => {
        value.secretBindingsByConnectionId.pc_1.account = Object.fromEntries(
          Array.from({ length: 8 }, (_, index) => [`slot-${index}`, `secret-${index}`]),
        );
      },
      over: (value) => { value.secretBindingsByConnectionId.pc_1.account['slot-over'] = 'secret-over'; },
    },
    {
      label: 'defaults by agent target key',
      atBound: (value) => {
        value.defaultsByAgentTargetKey = Object.fromEntries(Array.from({ length: 2_048 }, (_, index) => {
          const agentTargetKey = `agent:${index}`;
          return [agentTargetKey, {
            v: 1, ref: { agentTargetKey, providerConnectionId: null, modelId: 'native' }, updatedAt: 1,
          }];
        }));
      },
      over: (value) => {
        value.defaultsByAgentTargetKey['agent:over'] = {
          v: 1, ref: { agentTargetKey: 'agent:over', providerConnectionId: null, modelId: 'native' }, updatedAt: 1,
        };
      },
    },
    {
      label: 'migration completed sources',
      atBound: (value) => {
        value.migration = {
          v: 1,
          completedSources: Array.from({ length: 2_048 }, (_, index) => ({
            sourceProfileId: `completed-${index}`, kind: 'default_environment',
          })),
          pendingCustomProfileIds: [],
          migratedAt: 1,
        };
      },
      over: (value) => {
        value.migration.completedSources.push({ sourceProfileId: 'completed-over', kind: 'default_environment' });
      },
    },
    {
      label: 'migration pending custom profiles',
      atBound: (value) => {
        value.migration = {
          v: 1,
          completedSources: [],
          pendingCustomProfileIds: Array.from({ length: 2_048 }, (_, index) => `pending-${index}`),
          migratedAt: 1,
        };
      },
      over: (value) => { value.migration.pendingCustomProfileIds.push('pending-over'); },
    },
  ];

  it.each(nestedCountCaps)('maps the $label cap to the stable settings-limit error', ({ atBound, over }) => {
    const value = structuredClone(validSettings()) as any;
    atBound(value);
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength)
      .toBeLessThanOrEqual(PROVIDER_SETTINGS_LIMITS_V1.decodedJsonBytes);
    expect(() => assertProviderSettingsV1WithinLimits(value)).not.toThrow();

    const overValue = structuredClone(value);
    over(overValue);
    expect(() => assertProviderSettingsV1WithinLimits(overValue)).toThrowError(ProviderSettingsLimitError);
  });

  it('maps the total manual-model cap to the stable settings-limit error', () => {
    const totalManualOver = structuredClone(DEFAULT_PROVIDER_SETTINGS_V1) as any;
    totalManualOver.connections = Array.from({ length: 11 }, (_, index) =>
      ({ ...connection(`pc_${index}`, `plugin/p-${index}`), role: 'named', displayNameMode: 'custom' }));
    totalManualOver.manualModelsByConnectionId = Object.fromEntries(totalManualOver.connections.map((entry: { id: string }, index: number) => [
      entry.id,
      Array.from({ length: index === 10 ? 1 : 500 }, (_, modelIndex) => ({ id: `m-${index}-${modelIndex}`, addedAt: 1 })),
    ]));
    // The total cap, not the shared byte ceiling, must be the refusal reason here.
    expect(new TextEncoder().encode(JSON.stringify(totalManualOver)).byteLength)
      .toBeLessThanOrEqual(PROVIDER_SETTINGS_LIMITS_V1.decodedJsonBytes);
    expect(() => assertProviderSettingsV1WithinLimits(totalManualOver))
      .toThrowError(/total manual-model limit/u);
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

  it('accepts endpoint-override machine branches beyond the retired global count', () => {
    const over = structuredClone(validSettings()) as any;
    over.connections[0].endpointOverridesByMachineId = Object.fromEntries(
      Array.from({ length: 2_049 }, (_, index) => [`machine-${index}`, []]),
    );
    expect(() => assertProviderSettingsV1WithinLimits(over)).not.toThrow();
    const recovered = parseProviderSettingsV1Narrow(over);
    expect(recovered.settings.connections).toHaveLength(1);
    expect(Object.keys(recovered.settings.connections[0]?.endpointOverridesByMachineId ?? {})).toHaveLength(2_049);
    expect(recovered.diagnostics).toEqual([]);
  });

  it('accepts valid account and machine grants beyond the retired global counts, bounded only by the subtree budget', () => {
    const connections = Array.from({ length: 257 }, (_, index) => connection(`pc-${index}`, `plugin/provider-${index}`));
    const machineGrant = (index: number) => ({
      v: 1 as const,
      machineId: `m-${index}`,
      connectionId: 'pc-0',
      endpointSetFingerprint: `endpoint-set:v1:${index}`,
      connectionSecurityFingerprint: 'connection-security:v1:pc-0',
      confirmedAt: 1,
    });
    const value = {
      ...DEFAULT_PROVIDER_SETTINGS_V1,
      connections,
      accountGrants: connections.map((entry) => ({
        v: 1 as const,
        connectionId: entry.id,
        connectionSecurityFingerprint: `connection-security:v1:${entry.id}`,
        confirmedAt: 1,
      })),
      machineGrants: Array.from({ length: 513 }, (_, index) => machineGrant(index)),
    };
    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength)
      .toBeLessThanOrEqual(PROVIDER_SETTINGS_LIMITS_V1.decodedJsonBytes);
    expect(() => assertProviderSettingsV1WithinLimits(value)).not.toThrow();
    expect(ProviderSettingsV1Schema.parse(value).accountGrants).toHaveLength(257);
    expect(ProviderSettingsV1Schema.parse(value).machineGrants).toHaveLength(513);

    // Grants carry no count cap of their own; the shared subtree budget is what bounds them,
    // and it refuses before Account Settings can silently drop the persisted subtree.
    const overBudget = {
      ...value,
      machineGrants: Array.from({ length: 4_096 }, (_, index) => machineGrant(index)),
    };
    expect(new TextEncoder().encode(JSON.stringify(overBudget)).byteLength)
      .toBeGreaterThan(PROVIDER_SETTINGS_LIMITS_V1.decodedJsonBytes);
    expect(() => assertProviderSettingsV1WithinLimits(overBudget))
      .toThrowError(/decoded-size limit/u);
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

  it('retains all valid connection records during narrow read recovery', () => {
    const raw = structuredClone(DEFAULT_PROVIDER_SETTINGS_V1) as any;
    raw.connections = Array.from({ length: 257 }, (_, index) => connection(`pc_${index}`, `plugin/p-${index}`));
    const parsed = parseProviderSettingsV1Narrow(raw);
    expect(parsed.settings.connections).toHaveLength(257);
    expect(parsed.diagnostics).toEqual([]);
  });

  it('bounds default-selection recovery instead of throwing on an oversized sibling map', () => {
    const raw = structuredClone(DEFAULT_PROVIDER_SETTINGS_V1) as any;
    raw.defaultsByAgentTargetKey = Object.fromEntries(
      Array.from({ length: 2_049 }, (_, index) => {
        const agentTargetKey = `agent:${index}`;
        return [agentTargetKey, {
          v: 1,
          ref: { agentTargetKey, providerConnectionId: null, modelId: 'native' },
          updatedAt: 1,
        }];
      }),
    );

    const parsed = parseProviderSettingsV1Narrow(raw);
    expect(Object.keys(parsed.settings.defaultsByAgentTargetKey)).toHaveLength(2_048);
    expect(parsed.settings.defaultsByAgentTargetKey['agent:2048']).toBeUndefined();
    expect(parsed.diagnostics).toContainEqual({
      path: 'defaultsByAgentTargetKey',
      reason: 'limit_exceeded',
    });
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

  it('retains migration revision and implicit-versus-explicit selection provenance', () => {
    const settings = structuredClone(validSettings()) as any;
    settings.connections.push({
      v: 1, id: 'pc-deepseek', source: { kind: 'contribution', contributionKey: 'happier.provider.deepseek/deepseek' },
      role: 'default', displayName: 'DeepSeek', displayNameMode: 'automatic', revision: 0, createdAt: 1, updatedAt: 1,
    });
    settings.migration = {
      v: 1,
      completedSources: [{
        sourceProfileId: 'deepseek', kind: 'connection', connectionId: 'pc-deepseek',
        sourceRevision: 2, modelSelectionOrigin: 'implicit_default',
        modelSelection: { agentTargetKey: 'agent:claude', providerConnectionId: 'pc-deepseek', modelId: 'deepseek-v4-flash' },
      }],
      pendingCustomProfileIds: [],
      pendingConflicts: [],
    };
    expect(ProviderSettingsV1Schema.parse(settings).migration?.completedSources[0]).toMatchObject({
      sourceRevision: 2,
      modelSelectionOrigin: 'implicit_default',
    });
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
      pendingConflicts: [],
      migratedAt: 2,
    });
    expect(parsed.diagnostics).toContainEqual({
      path: 'migration.pendingCustomProfileIds[0]', reason: 'already_completed',
    });
  });

  it('bounds redacted migration model choices and exposes them only for model conflicts', () => {
    const base = {
      v: 1 as const,
      sourceProfileId: 'deepseek',
      contributionKey: 'happier.provider.deepseek/deepseek',
      existingConnectionId: 'pc_existing',
      kinds: ['manual_model'] as const,
      candidateFingerprint: 'legacy-profile-migration-conflict:v1:test',
      detectedAt: 1,
    };
    const legacy = {
      kind: 'legacy' as const,
      selection: { agentTargetKey: 'agent:claude', modelId: 'legacy-model' },
      label: 'Legacy model',
    };
    const existing = {
      kind: 'existing' as const,
      selection: { agentTargetKey: 'agent:claude', modelId: 'existing-model' },
    };
    expect(ProviderSettingsMigrationPendingConflictV1Schema.parse({
      ...base, modelChoices: [existing, legacy],
    }).modelChoices).toEqual([existing, legacy]);
    expect(ProviderSettingsMigrationPendingConflictV1Schema.safeParse({
      ...base, kinds: ['credential_binding'], modelChoices: [legacy],
    }).success).toBe(false);
    expect(ProviderSettingsMigrationPendingConflictV1Schema.safeParse({
      ...base, modelChoices: [legacy, legacy],
    }).success).toBe(false);
    expect(ProviderSettingsMigrationPendingConflictV1Schema.safeParse({
      ...base, modelChoices: [legacy, existing, {
        kind: 'legacy', selection: { agentTargetKey: 'agent:claude', modelId: 'third' },
      }],
    }).success).toBe(false);
  });
});
