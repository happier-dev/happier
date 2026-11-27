import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_SETTING_DEFINITIONS,
  ACCOUNT_SETTING_KEYS,
  accountSettingsParse,
} from './accountSettings.js';
import {
  AccountSettingMutationV1Schema,
  applyAccountSettingMutationV1,
  type AccountSettingsMutationResult,
} from './accountSettingMutationV1.js';
import { readSavedSecretTransferSourceV1 } from './savedSecretMutationOwner.js';
import { normalizeTransferredAccountSettingsHistoryV1 } from './accountSettingsHistoryRestoreV1.js';

function connectedAccountServiceConfigurationsV1Entry(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    service: { pluginId: 'acme.accounts', localId: 'work' },
    modeId: 'oauth',
    revision: 'configuration-1',
    values: { endpoint: 'https://api.example.test' },
    secretRefs: { clientSecret: 'saved-secret-1' },
    ...overrides,
  };
}

describe('AccountSettingMutationV1', () => {
  it('retires the released commit-message Agent input before applying current Settings intent', () => {
    const legacy = { favoriteMachines: ['neighbor'], scmCommitMessageGeneratorBackendId: 'codex' };
    const migratedRunner = accountSettingsParse(legacy).scmCommitMessageGeneratorRunnerV1;
    expect(migratedRunner).toMatchObject({ modelSelection: { agentTargetKey: 'agent:happier.agent.codex/codex' } });

    const incidental = applyAccountSettingMutationV1(legacy, { operations: [{ op: 'set', key: 'showLineNumbers', value: true }] });
    expect(incidental).toEqual({ status: 'applied', raw: {
      favoriteMachines: ['neighbor'], scmCommitMessageGeneratorRunnerV1: migratedRunner, showLineNumbers: true,
    } });
    const reset = applyAccountSettingMutationV1(legacy, { operations: [{ op: 'reset', key: 'scmCommitMessageGeneratorRunnerV1' }] });
    expect(reset).toEqual({ status: 'applied', raw: { favoriteMachines: ['neighbor'] } });
    expect(AccountSettingMutationV1Schema.safeParse({
      operations: [{ op: 'set', key: 'scmCommitMessageGeneratorBackendId', value: 'codex' }],
    }).success).toBe(false);
  });

  it('preserves caller-surface policy on an older Actions writer and allows an explicit current reset', () => {
    const callerSurfacePolicies = { foreign_session_html: { 'session.message.send': 'off', 'acme.preview/resources/status': 'allowed' } };
    const initial = { actionsSettingsV1: { v: 1, actions: {}, callerSurfacePolicies } };
    const updated = applyAccountSettingMutationV1(initial, { operations: [{ op: 'set', key: 'actionsSettingsV1',
      value: { v: 1, actions: { 'session.stop': { enabled: false } } },
    }] });
    expect(updated.status).toBe('applied');
    if (updated.status !== 'applied') throw new Error('Expected settings update');
    expect(accountSettingsParse(updated.raw).actionsSettingsV1).toMatchObject({ callerSurfacePolicies,
      actions: { 'session.stop': { enabled: false } } });
    const cleared = applyAccountSettingMutationV1(updated.raw, { operations: [{ op: 'set', key: 'actionsSettingsV1',
      value: { v: 1, actions: {}, callerSurfacePolicies: {} },
    }] });
    expect(cleared.status).toBe('applied');
    if (cleared.status !== 'applied') throw new Error('Expected explicit reset');
    expect(accountSettingsParse(cleared.raw).actionsSettingsV1).toMatchObject({ callerSurfacePolicies: {} });
  });
  it('stores an adjustable autonomous exchange check-in without changing delegation depth', () => {
    expect(accountSettingsParse({}).coordinationAutonomousCheckIn).toEqual({ afterTurns: 5 });
    for (const afterTurns of [null, 1, 10_000]) {
      const changed = applyAccountSettingMutationV1({ workDepthLimit: 4 }, {
        operations: [{ op: 'set', key: 'coordinationAutonomousCheckIn', value: { afterTurns } }],
      });
      expect(changed).toEqual({ status: 'applied', raw: {
        workDepthLimit: 4, coordinationAutonomousCheckIn: { afterTurns },
      } });
    }
    for (const value of [{ afterTurns: 0 }, { afterTurns: -1 }, { afterTurns: 1.5 },
      { afterTurns: '5' }, { afterTurns: 5, other: true }]) {
      expect(applyAccountSettingMutationV1({}, {
        operations: [{ op: 'set', key: 'coordinationAutonomousCheckIn', value }],
      })).toEqual({ status: 'invalid', reason: 'invalidValue' });
    }
  });
  it('preserves a retained Replay budget below the writable floor during an unrelated preference change', () => {
    // This value is retained by the real QA Account; new Replay writes must
    // still meet the seed renderer's structural floor.
    const raw = { sessionReplayMaxSeedChars: 1024, machineOfflineAlertsV1: { machineIds: ['peer'] } };
    expect(applyAccountSettingMutationV1(raw, {
      operations: [{ op: 'set', key: 'machineOfflineAlertsV1', value: { machineIds: ['peer', 'machine-one'] } }],
    })).toEqual({ status: 'applied', raw: { ...raw, machineOfflineAlertsV1: { machineIds: ['peer', 'machine-one'] } } });
    expect(applyAccountSettingMutationV1({}, {
      operations: [{ op: 'set', key: 'sessionReplayMaxSeedChars', value: 1024 }],
    })).toEqual({ status: 'invalid', reason: 'invalidValue' });
  });
  it('persists machine offline enrollment through the Account preference owner', () => {
    const result = applyAccountSettingMutationV1({ showLineNumbers: false }, {
      operations: [{ op: 'set', key: 'machineOfflineAlertsV1', value: { machineIds: ['machine-one'] } }],
    });
    expect(result).toEqual({ status: 'applied', raw: {
      showLineNumbers: false, machineOfflineAlertsV1: { machineIds: ['machine-one'] },
    } });
    expect(accountSettingsParse({})).toHaveProperty('machineOfflineAlertsV1', { machineIds: [] });
    expect(applyAccountSettingMutationV1({}, {
      operations: [{ op: 'set', key: 'machineOfflineAlertsV1', value: { machineIds: [42] } }],
    }).status).toBe('invalid');
  });
  it.each([
    ['sessionAgentSpawnPolicyV1', { allowCrossMachine: 'yes' }],
    ['sessionAgentSpawnPolicyV1', { allowCrossMachine: false, futureField: true }],
    ['sessionAgentStartAllowListsV1', { allowedRoleIds: 'builder' }],
    ['sessionAgentStartAllowListsV1', { allowedRoleIds: ['builder'], futureField: true }],
  ] as const)('rejects malformed incoming %s without applying neighboring preferences', (key, value) => {
    const raw = {
      sessionAgentSpawnPolicyV1: { allowCrossMachine: false, allowCustomDirectory: false },
      sessionAgentStartAllowListsV1: { allowedRoleIds: ['builder'], allowedAgentTargetKeys: [] },
      showLineNumbers: true,
      futureSetting: { keep: true },
    };
    const before = structuredClone(raw);
    const mutation = { operations: [
      { op: 'set', key: 'showLineNumbers', value: false },
      { op: 'set', key, value },
    ] };
    expect(AccountSettingMutationV1Schema.safeParse(mutation).success).toBe(false);
    expect(applyAccountSettingMutationV1(raw, mutation)).toEqual({ status: 'invalid', reason: 'invalidValue' });
    expect(raw).toEqual(before);
  });

  it('admits valid policy writes and explicit resets without changing neighboring restrictions', () => {
    const raw = {
      sessionAgentSpawnPolicyV1: { allowCrossMachine: false, allowCustomDirectory: false },
      sessionAgentStartAllowListsV1: { allowedRoleIds: ['builder'], allowedAgentTargetKeys: [] },
      futureSetting: { keep: true },
    };
    const validPolicy = accountSettingsParse(raw).sessionAgentSpawnPolicyV1;
    expect(applyAccountSettingMutationV1(raw, { operations: [
      { op: 'set', key: 'sessionAgentSpawnPolicyV1', value: { ...validPolicy, allowEnvironmentVariables: false } },
    ] })).toEqual({ status: 'applied', raw: { ...raw, sessionAgentSpawnPolicyV1: { ...validPolicy, allowEnvironmentVariables: false } } });
    expect(applyAccountSettingMutationV1(raw, { operations: [
      { op: 'set', key: 'sessionAgentStartAllowListsV1', value: { v: 1, allowedRoleIds: [], allowedAgentTargetKeys: null } },
    ] })).toEqual({ status: 'applied', raw: { ...raw, sessionAgentStartAllowListsV1: { v: 1, allowedRoleIds: [], allowedAgentTargetKeys: null } } });
    const { sessionAgentStartAllowListsV1: _, ...withoutAllowLists } = raw;
    expect(applyAccountSettingMutationV1(raw, { operations: [
      { op: 'reset', key: 'sessionAgentStartAllowListsV1' },
    ] })).toEqual({ status: 'applied', raw: withoutAllowLists });
  });
  it('keeps transferred entity carriers read-only while preserving their raw provenance during preference mutation', () => {
    const sources = { profiles: [], secretBindingsByProfileId: {}, promptStacksV1: { v: 1, surfaces: {
      coding: [], voice: [], profilesById: {} } }, rolesV1: { overrides: {} }, promptFoldersV1: { v: 1, folders: [] },
      promptInvocationsV1: { v: 1, entries: [] }, promptExternalLinksV1: { v: 1, links: [] },
      promptRegistrySourcesV1: { v: 1, sources: [] }, contextSelectionsV1: { v: 1, selectionsByKey: {} },
      executionRunsGuidanceEntries: [] };
    for (const [key, value] of Object.entries(sources)) {
      expect(applyAccountSettingMutationV1({}, { operations: [{ op: 'set', key, value }] }))
        .toEqual({ status: 'invalid', reason: 'unknownKey' });
      expect(accountSettingsParse(sources)).not.toHaveProperty(key);
    }
    expect(applyAccountSettingMutationV1(sources, { operations: [{ op: 'set', key: 'showLineNumbers', value: false }] }))
      .toEqual({ status: 'applied', raw: { ...sources, showLineNumbers: false } });
  });
  it('rejects retired preference and inference writers without discarding an untransferred credential carrier', () => {
    const aliases = { viewInline: true, expandTodos: false, usePickerSearch: true,
      compactSessionView: false, compactSessionViewMinimal: false, reviewPromptAnswered: true,
      reviewPromptLikedApp: true, lastUsedPermissionMode: 'yolo', lastUsedModelMode: 'default',
      inferenceOpenAIKey: '  exact inference fixture\n' };
    for (const [key, value] of Object.entries(aliases)) {
      expect(applyAccountSettingMutationV1({}, { operations: [{ op: 'set', key, value }] }))
        .toEqual({ status: 'invalid', reason: 'unknownKey' });
      expect(accountSettingsParse(aliases)).not.toHaveProperty(key);
    }
    const changed = applyAccountSettingMutationV1(aliases, {
      operations: [{ op: 'set', key: 'showLineNumbers', value: false }],
    });
    expect(changed).toEqual({ status: 'applied', raw: { ...aliases, showLineNumbers: false } });
    if (changed.status !== 'applied') throw new Error('expected admitted preference');
    expect(readSavedSecretTransferSourceV1(changed.raw).inferenceCredential?.value)
      .toBe(aliases.inferenceOpenAIKey);
  });
  it('imports an exact 0.2 inference string above newer catalog field limits without making it writable', () => {
    // 0.2 accountLegacySettingDefinitions uses a nullish string with no field cap.
    const value = `  ${'retained-inference-fixture'.repeat(3000)}\n`;
    expect(new TextEncoder().encode(value).byteLength).toBeGreaterThan(64 * 1024);
    const raw = { inferenceOpenAIKey: value };
    expect(readSavedSecretTransferSourceV1(raw).inferenceCredential?.value).toBe(value);
    expect(normalizeTransferredAccountSettingsHistoryV1(raw, { activeTransferredRoots: [] }))
      .toEqual({ status: 'unchanged', cleanupPending: true, raw });
  });
  it('keeps retired Machine Administration data opaque on sparse writes and rejects edits to the retired key', () => {
    const selections = { v: 1, pluginExecutionOriginsByPluginId: {},
      targetsByKey: { agents: { serverIdentityId: 'srv_home', machineId: 'machine-1' } } };
    const raw = { machineAdministrationSelectionsV1: selections, neighbor: { keep: true } };
    expect(accountSettingsParse(raw)).toMatchObject(raw);
    expect(applyAccountSettingMutationV1(raw, {
      operations: [{ op: 'set', key: 'workDepthLimit', value: 4 }],
    })).toEqual({ status: 'applied', raw: { ...raw, workDepthLimit: 4 } });
    expect(applyAccountSettingMutationV1({}, {
      operations: [{ op: 'set', key: 'machineAdministrationSelectionsV1', value: selections }],
    })).toEqual({ status: 'invalid', reason: 'unknownKey' });
  });
  it('keeps MCP strict enforcement as a boolean preference separate from catalog entities', () => {
    expect(accountSettingsParse({})).toMatchObject({ mcpServersStrictMode: false });
    expect(applyAccountSettingMutationV1({ unrelated: { preserve: true } }, {
      operations: [{ op: 'set', key: 'mcpServersStrictMode', value: true }],
    })).toEqual({ status: 'applied', raw: { unrelated: { preserve: true }, mcpServersStrictMode: true } });
    expect(applyAccountSettingMutationV1({}, {
      operations: [{ op: 'set', key: 'mcpServersStrictMode', value: 'true' }],
    })).toEqual({ status: 'invalid', reason: 'invalidValue' });
  });
  it('refuses draft Project settings writes while retaining opaque raw data and predecessor organization', () => {
    const raw = {
      workspaceRefsV1: [{ id: 'repairable-retained-ref' }],
      sessionFoldersV1: { v: 1, folders: [] },
      workspaceLabelsV1: { '/repo': 'Repository' },
      pinnedSessionKeysV1: ['home:session'],
    };
    for (const key of ['workspaceRefsV1', 'workspaceSyncRelationshipsV1', 'pinnedWorkspaceRefIdsV1']) {
      expect(applyAccountSettingMutationV1(raw, { operations: [{ op: 'set', key, value: [] }] }))
        .toEqual({ status: 'invalid', reason: 'unknownKey' });
      expect(accountSettingsParse({})).not.toHaveProperty(key);
    }
    const changed = applyAccountSettingMutationV1(raw, { operations: [{ op: 'set', key: 'showLineNumbers', value: false }] });
    expect(changed).toMatchObject({ status: 'applied', raw: { ...raw, showLineNumbers: false } });
  });

  it('retains independent new-session and new-bot memory preferences with strict boolean mutations', () => {
    const defaults = accountSettingsParse({});
    expect(defaults).toMatchObject({ memoryUseInNewSessions: false, memoryUseInNewBots: true });
    const changed = applyAccountSettingMutationV1({ unrelatedFuturePreference: { enabled: true } }, {
      operations: [
        { op: 'set', key: 'memoryUseInNewSessions', value: true },
        { op: 'set', key: 'memoryUseInNewBots', value: false },
      ],
    });
    expect(changed).toEqual({ status: 'applied', raw: {
      unrelatedFuturePreference: { enabled: true }, memoryUseInNewSessions: true, memoryUseInNewBots: false,
    } });
    if (changed.status !== 'applied') throw new Error('Expected admitted preferences');
    expect(accountSettingsParse(changed.raw)).toMatchObject({ memoryUseInNewSessions: true, memoryUseInNewBots: false });
    expect(accountSettingsParse({ memoryUseInNewSessions: 'invalid', memoryUseInNewBots: 'invalid' }))
      .toMatchObject({ memoryUseInNewSessions: false, memoryUseInNewBots: true });
    for (const key of ['memoryUseInNewSessions', 'memoryUseInNewBots']) {
      expect(applyAccountSettingMutationV1({}, { operations: [{ op: 'set', key, value: 'true' }] }))
        .toEqual({ status: 'invalid', reason: 'invalidValue' });
    }
    expect(applyAccountSettingMutationV1({ memoryUseInNewSessions: 'invalid', memoryUseInNewBots: false,
      unrelatedFuturePreference: { enabled: true } }, { operations: [{ op: 'set', key: 'memoryUseInNewSessions', value: true }] }))
      .toEqual({ status: 'applied', raw: { memoryUseInNewSessions: true, memoryUseInNewBots: false,
        unrelatedFuturePreference: { enabled: true } } });
    expect(applyAccountSettingMutationV1({ memoryUseInNewSessions: true, memoryUseInNewBots: 'invalid' }, {
      operations: [{ op: 'set', key: 'memoryUseInNewSessions', value: false }],
    })).toEqual({ status: 'applied', raw: { memoryUseInNewSessions: false, memoryUseInNewBots: true } });
    expect(applyAccountSettingMutationV1({ showLineNumbers: 'invalid', memoryUseInNewSessions: 'invalid' }, {
      operations: [{ op: 'set', key: 'memoryUseInNewSessions', value: true }],
    })).toEqual({ status: 'invalid', reason: 'invalidValue' });
  });

  it('preserves predecessor Profile favorite identities and complete collections through the canonical preference mutation', () => {
    // The inspected 0.2 favorite writer accepts exact strings and an unbounded
    // array; both the long identity and the 257th neighbor are retained inputs.
    const favoriteProfiles = [` legacy-${'x'.repeat(33 * 1024)} `,
      ...Array.from({ length: 256 }, (_, index) => `profile-${index}`)];
    const raw = { favoriteProfiles, futurePreference: { keep: true } };
    expect(accountSettingsParse(raw).favoriteProfiles).toEqual(favoriteProfiles);
    const nextFavorites = ['new', ...favoriteProfiles];
    expect(applyAccountSettingMutationV1(raw, {
      operations: [{ op: 'set', key: 'favoriteProfiles', value: nextFavorites }],
    })).toEqual({ status: 'applied', raw: { ...raw, favoriteProfiles: nextFavorites } });
    expect(applyAccountSettingMutationV1(raw, {
      operations: [{ op: 'set', key: 'favoriteProfiles', value: ['valid', 7] }],
    })).toEqual({ status: 'invalid', reason: 'invalidValue' });
  });

  it.each([
    ['connectedAccountServiceConfigurationsV1', { v: 1, entries: [connectedAccountServiceConfigurationsV1Entry()] }],
    ['providerSettingsV1', { futureProviderState: { keep: true } }],
  ] as const)('refuses retired %s writes while preserving captured raw provenance during a preference mutation', (key, value) => {
    expect(ACCOUNT_SETTING_KEYS).not.toContain(key);
    const raw = { [key]: value, showLineNumbers: true, futureSetting: { keep: true } };
    const before = structuredClone(raw);
    for (const operation of [{ op: 'set', key, value }, { op: 'reset', key }]) {
      expect(applyAccountSettingMutationV1(raw, { operations: [
        { op: 'set', key: 'showLineNumbers', value: false }, operation,
      ] })).toEqual({ status: 'invalid', reason: 'unknownKey' });
      expect(raw).toEqual(before);
    }
    expect(applyAccountSettingMutationV1(raw, { operations: [
      { op: 'set', key: 'showLineNumbers', value: false },
    ] })).toEqual({ status: 'applied', raw: { ...raw, showLineNumbers: false } });
    expect(accountSettingsParse(raw)).not.toHaveProperty(key);
    expect(raw).toEqual(before);
  });

  it('accepts one to 64 unique operations and rejects empty or oversized lists', () => {
    expect(ACCOUNT_SETTING_KEYS.length).toBeGreaterThanOrEqual(65);
    const resetOperations = ACCOUNT_SETTING_KEYS.slice(0, 65).map((key) => ({
      op: 'reset' as const,
      key,
    }));

    expect(AccountSettingMutationV1Schema.safeParse({ operations: [] }).success).toBe(false);
    expect(AccountSettingMutationV1Schema.safeParse({ operations: resetOperations.slice(0, 1) }).success).toBe(true);
    expect(AccountSettingMutationV1Schema.safeParse({ operations: resetOperations.slice(0, 64) }).success).toBe(true);
    expect(AccountSettingMutationV1Schema.safeParse({ operations: resetOperations }).success).toBe(false);
  });

  it('rejects duplicate keys instead of making operation order authoritative', () => {
    const mutation = {
      operations: [
        { op: 'set', key: 'sessionPendingQueueDeliveryTiming', value: 'after_runtime_idle' },
        { op: 'reset', key: 'sessionPendingQueueDeliveryTiming' },
      ],
    } as const;

    expect(AccountSettingMutationV1Schema.safeParse(mutation).success).toBe(false);
    expect(applyAccountSettingMutationV1({}, mutation)).toEqual({
      status: 'invalid',
      reason: 'duplicateKey',
    });
  });

  it('classifies unknown keys, invalid key values, per-key oversize values, and excessive depth', () => {
    expect(applyAccountSettingMutationV1({}, {
      operations: [{ op: 'reset', key: 'futureSettingOwnedElsewhere' }],
    })).toEqual({ status: 'invalid', reason: 'unknownKey' });

    expect(applyAccountSettingMutationV1({}, {
      operations: [{
        op: 'set',
        key: 'sessionPendingQueueDeliveryTiming',
        value: 'eventually',
      }],
    })).toEqual({ status: 'invalid', reason: 'invalidValue' });

    expect(applyAccountSettingMutationV1({}, {
      operations: [{
        op: 'set',
        key: 'voiceDiagnosticsV1',
        value: 'x'.repeat((64 * 1024) + 1),
      }],
    })).toEqual({ status: 'invalid', reason: 'tooLarge' });

    let tooDeep: unknown = 'leaf';
    for (let depth = 0; depth < 14; depth += 1) tooDeep = { child: tooDeep };
    expect(applyAccountSettingMutationV1({}, {
      operations: [{
        op: 'set',
        key: 'voiceDiagnosticsV1',
        value: tooDeep,
      }],
    })).toEqual({ status: 'invalid', reason: 'tooDeep' });
  });

  it('leaves current Provider default cardinality to the domain while enforcing its Account byte ceiling', () => {
    const key = 'providerDefaultModelSelectionsByAgentTargetKeyV1';
    const defaults = (count: number, modelId = 'base-model') => Object.fromEntries(
      Array.from({ length: count }, (_, index) => {
        const agentTargetKey = `agent:acme.agents/coding-${index}`;
        return [agentTargetKey, { v: 1, ref: { agentTargetKey, providerConnectionId: null, modelId }, updatedAt: 1 }];
      }),
    );
    // The current Provider admits this population above the generic Account width.
    const wide = defaults(300);
    const raw = { futureSetting: { keep: true } };
    expect(ACCOUNT_SETTING_DEFINITIONS[key].parseMutationValue(wide).success).toBe(true);
    expect(applyAccountSettingMutationV1(raw, { operations: [{ op: 'set', key, value: wide }] }))
      .toEqual({ status: 'applied', raw: { ...raw, [key]: wide } });
    const oversized = defaults(1500, 'm'.repeat(150));
    expect(new TextEncoder().encode(JSON.stringify(oversized)).byteLength)
      .toBeGreaterThan(ACCOUNT_SETTING_DEFINITIONS[key].maximumSerializedValueBytes);
    expect(applyAccountSettingMutationV1(raw, { operations: [{ op: 'set', key, value: oversized }] }))
      .toEqual({ status: 'invalid', reason: 'tooLarge' });
    expect(applyAccountSettingMutationV1(raw, { operations: [{ op: 'set', key, value: {
      'agent:acme.agents/coding': { v: 1, ref: { agentTargetKey: 'agent:acme.agents/other', providerConnectionId: null, modelId: 'base-model' }, updatedAt: 1 },
    } }] })).toEqual({ status: 'invalid', reason: 'invalidValue' });
    expect(raw).toEqual({ futureSetting: { keep: true } });
  });

  it('resets a retained machine host without reviving its development alias or dropping neighbors', () => {
    const raw = {
      sessionTmuxByMachineId: {
        machine: {
          useTmux: false, terminalHost: 'herdr', sessionName: 'work', isolated: false,
          tmpDir: '/tmp/work', futureOption: { keep: true },
        },
        other: { useTmux: true, sessionName: 'other', isolated: true, tmpDir: null },
      },
      futureSetting: { keep: true },
    };
    expect(accountSettingsParse(raw).sessionTerminalHostByMachineId).toEqual({ machine: 'herdr' });
    const result = applyAccountSettingMutationV1(raw, {
      operations: [{ op: 'reset', key: 'sessionTerminalHostByMachineId' }],
    });
    expect(result.status).toBe('applied');
    if (result.status === 'invalid') throw new Error('Expected a valid Account reset');
    expect(result.raw).toEqual({
      sessionTmuxByMachineId: {
        machine: {
          useTmux: false, sessionName: 'work', isolated: false,
          tmpDir: '/tmp/work', futureOption: { keep: true },
        },
        other: { useTmux: true, sessionName: 'other', isolated: true, tmpDir: null },
      },
      futureSetting: { keep: true },
    });
    expect(result.raw).not.toHaveProperty('sessionTerminalHostByMachineId');
    expect(accountSettingsParse(result.raw).sessionTerminalHostByMachineId).toEqual({});
    expect(raw.sessionTmuxByMachineId.machine.terminalHost).toBe('herdr');
  });

  it('sets and resets only named persisted keys while preserving structurally valid future raw neighbors', () => {
    const raw = {
      sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
      futureSetting: { keep: true },
    };

    expect(applyAccountSettingMutationV1(raw, {
      operations: [{
        op: 'set',
        key: 'sessionPendingQueueDeliveryTiming',
        value: 'after_runtime_idle',
      }],
    })).toEqual({
      status: 'applied',
      raw: {
        sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
        futureSetting: { keep: true },
      },
    });

    expect(applyAccountSettingMutationV1(raw, {
      operations: [{ op: 'reset', key: 'sessionPendingQueueDeliveryTiming' }],
    })).toEqual({
      status: 'applied',
      raw: {
        futureSetting: { keep: true },
      },
    });
  });

  it('does not overwrite a malformed present value but permits an explicit reset to recover it', () => {
    const raw = { sessionPendingQueueDeliveryTiming: 'malformed-present-root', futureSetting: { keep: true } };
    expect(applyAccountSettingMutationV1(raw, {
      operations: [{
        op: 'set',
        key: 'sessionPendingQueueDeliveryTiming',
        value: 'after_runtime_idle',
      }],
    })).toEqual({ status: 'invalid', reason: 'invalidValue' });
    expect(raw).toEqual({ sessionPendingQueueDeliveryTiming: 'malformed-present-root', futureSetting: { keep: true } });

    expect(applyAccountSettingMutationV1(raw, {
      operations: [{ op: 'reset', key: 'sessionPendingQueueDeliveryTiming' }],
    })).toEqual({ status: 'applied', raw: { futureSetting: { keep: true } } });
    expect(raw).toEqual({ sessionPendingQueueDeliveryTiming: 'malformed-present-root', futureSetting: { keep: true } });
  });

  it('reports exact no-ops without materializing defaults', () => {
    const raw = { sessionPendingQueueDeliveryTiming: 'after_runtime_idle' };
    expect(applyAccountSettingMutationV1(raw, {
      operations: [{
        op: 'set',
        key: 'sessionPendingQueueDeliveryTiming',
        value: 'after_runtime_idle',
      }],
    })).toEqual({ status: 'unchanged', raw });
  });

  it('rejects an unrelated mutation when a preserved known root already violates structural bounds', () => {
    let overdeep: unknown = 'leaf';
    for (let depth = 0; depth < 14; depth += 1) overdeep = { child: overdeep };
    const overdeepRaw = {
      voiceDiagnosticsV1: overdeep,
      sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
    };
    expect(applyAccountSettingMutationV1(overdeepRaw, {
      operations: [{
        op: 'set',
        key: 'sessionPendingQueueDeliveryTiming',
        value: 'after_runtime_idle',
      }],
    })).toEqual({ status: 'invalid', reason: 'tooDeep' });
    expect(overdeepRaw.sessionPendingQueueDeliveryTiming).toBe('after_foreground_ready');

    const oversizedRaw = {
      inferenceOpenAIKey: 'x'.repeat((64 * 1024) + 1),
      sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
    };
    expect(applyAccountSettingMutationV1(oversizedRaw, {
      operations: [{
        op: 'set',
        key: 'sessionPendingQueueDeliveryTiming',
        value: 'after_runtime_idle',
      }],
    })).toEqual({ status: 'invalid', reason: 'tooLarge' });
    expect(oversizedRaw.sessionPendingQueueDeliveryTiming).toBe('after_foreground_ready');

    expect(applyAccountSettingMutationV1(overdeepRaw, {
      operations: [{ op: 'reset', key: 'voiceDiagnosticsV1' }],
    })).toEqual({
      status: 'applied',
      raw: { sessionPendingQueueDeliveryTiming: 'after_foreground_ready' },
    });
  });

  it('classifies every size refusal as tooLarge instead of an unclassified invalid value', () => {
    // A byte-ceiling refusal is a size refusal wherever it is observed. The
    // `set` path already reports `tooLarge`; a preserved root, a stale present
    // value, and a schema cardinality bound must not report a different reason
    // for the same violation, because callers branch on it to tell an operator
    // "reduce the payload" apart from "this value is malformed".
    const oversizedProviderRoot = { oversized: 'x'.repeat((256 * 1024) + 1) };
    expect(applyAccountSettingMutationV1({ providerSettingsV1: oversizedProviderRoot }, {
      operations: [{
        op: 'set',
        key: 'sessionPendingQueueDeliveryTiming',
        value: 'after_runtime_idle',
      }],
    })).toEqual({ status: 'invalid', reason: 'tooLarge' });

    // Only the per-key serialized ceiling is exceeded here: no string, record
    // width, or nesting depth breaks the Account document's generic policy, so
    // the generic structural inspector cannot be the one reporting it.
    const oversizedFeatureToggles = Object.fromEntries(
      Array.from({ length: 256 }, (_, index) => [`feature-${String(index).padStart(3, '0')}-${'x'.repeat(180)}`, true]),
    );
    expect(JSON.stringify(oversizedFeatureToggles).length).toBeGreaterThan(16 * 1024);
    expect(applyAccountSettingMutationV1({ featureToggles: oversizedFeatureToggles }, {
      operations: [{
        op: 'set',
        key: 'sessionPendingQueueDeliveryTiming',
        value: 'after_runtime_idle',
      }],
    })).toEqual({ status: 'invalid', reason: 'tooLarge' });

    expect(applyAccountSettingMutationV1({ featureToggles: oversizedFeatureToggles }, {
      operations: [{ op: 'set', key: 'featureToggles', value: { keep: true } }],
    })).toEqual({ status: 'invalid', reason: 'tooLarge' });

    // A domain schema's own cardinality bound is still a size refusal.
    expect(applyAccountSettingMutationV1({}, {
      operations: [{ op: 'set', key: 'preferredLanguage', value: 'l'.repeat(300) }],
    })).toEqual({ status: 'invalid', reason: 'tooLarge' });

    expect(applyAccountSettingMutationV1({}, {
      operations: ACCOUNT_SETTING_KEYS.slice(0, 65).map((key) => ({ op: 'reset' as const, key })),
    })).toEqual({ status: 'invalid', reason: 'tooLarge' });

    // Positive twin: nothing above turns an ordinary malformed value into a
    // size refusal, and a within-bounds document still applies.
    expect(applyAccountSettingMutationV1({}, {
      operations: [{ op: 'set', key: 'preferredLanguage', value: 42 }],
    })).toEqual({ status: 'invalid', reason: 'invalidValue' });
    expect(applyAccountSettingMutationV1({ providerSettingsV1: { small: true } }, {
      operations: [{ op: 'set', key: 'preferredLanguage', value: 'fr' }],
    })).toEqual({
      status: 'applied',
      raw: { providerSettingsV1: { small: true }, preferredLanguage: 'fr' },
    });
  });

  it('rejects structurally unsafe future roots while preserving bounded future roots exactly', () => {
    let overdeep: unknown = 'leaf';
    for (let depth = 0; depth < 14; depth += 1) overdeep = { child: overdeep };
    const mutation = {
      operations: [{
        op: 'set',
        key: 'sessionPendingQueueDeliveryTiming',
        value: 'after_runtime_idle',
      }],
    } as const;

    for (const futureValue of [
      overdeep,
      'x'.repeat((64 * 1024) + 1),
      Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`key-${index}`, index])),
    ]) {
      const raw = {
        futureSettingOwnedElsewhere: futureValue,
        sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
      };
      expect(applyAccountSettingMutationV1(raw, mutation)).toEqual({
        status: 'invalid',
        reason: futureValue === overdeep ? 'tooDeep' : 'tooLarge',
      });
      expect(raw.sessionPendingQueueDeliveryTiming).toBe('after_foreground_ready');
    }

    const boundedFutureValue = { nested: ['preserve', { exactly: true }] };
    expect(applyAccountSettingMutationV1({
      futureSettingOwnedElsewhere: boundedFutureValue,
      sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
    }, mutation)).toEqual({
      status: 'applied',
      raw: {
        futureSettingOwnedElsewhere: boundedFutureValue,
        sessionPendingQueueDeliveryTiming: 'after_runtime_idle',
      },
    });
  });

  it('rejects an unrelated mutation when a preserved known root is schema-invalid', () => {
    expect(applyAccountSettingMutationV1({
      promptExternalLinksV1: 'malformed-present-root',
      sessionPendingQueueDeliveryTiming: 'after_foreground_ready',
    }, {
      operations: [{
        op: 'set',
        key: 'sessionPendingQueueDeliveryTiming',
        value: 'after_runtime_idle',
      }],
    })).toEqual({ status: 'invalid', reason: 'invalidValue' });
  });

  it('publishes the approved realm-adapter result vocabulary from Protocol', () => {
    const settings = accountSettingsParse({});
    const results = [
      { status: 'applied', version: 1, settings },
      { status: 'satisfied', version: 1, settings },
      { status: 'unchanged', version: 1, settings },
      { status: 'conflict', currentVersion: 2 },
      { status: 'outcomeUnknown', lastKnownVersion: 2 },
      { status: 'cancelled', submitted: false },
      { status: 'locked', reason: 'encryptionMaterialUnavailable' },
      { status: 'locked', reason: 'modeMismatch' },
      { status: 'locked', reason: 'contentUnreadable' },
      { status: 'invalid', reason: 'unknownKey' },
      { status: 'invalid', reason: 'invalidValue' },
      { status: 'invalid', reason: 'duplicateKey' },
      { status: 'invalid', reason: 'tooLarge' },
      { status: 'invalid', reason: 'tooDeep' },
      { status: 'unavailable', retryable: true },
    ] as const satisfies readonly AccountSettingsMutationResult[];

    expect(results).toHaveLength(15);
  });
});
