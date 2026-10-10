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
  it('projects retained Settings fields for validation while keeping sparse writes and new inputs strict', () => {
    const selections = { v: 1, pluginExecutionOriginsByPluginId: {},
      targetsByKey: { agents: { serverIdentityId: 'srv_home', machineId: 'machine-1' } } };
    const raw = { machineAdministrationSelectionsV1: selections, neighbor: { keep: true } };
    expect(accountSettingsParse(raw).machineAdministrationSelectionsV1)
      .toEqual({ v: 1, pluginExecutionOriginsByPluginId: {} });
    expect(applyAccountSettingMutationV1(raw, {
      operations: [{ op: 'set', key: 'workDepthLimit', value: 4 }],
    })).toEqual({ status: 'applied', raw: { ...raw, workDepthLimit: 4 } });
    expect(applyAccountSettingMutationV1({}, {
      operations: [{ op: 'set', key: 'machineAdministrationSelectionsV1', value: selections }],
    })).toEqual({ status: 'invalid', reason: 'invalidValue' });
    expect(applyAccountSettingMutationV1({ ...raw, machineAdministrationSelectionsV1: {
      ...selections, pluginExecutionOriginsByPluginId: { 'acme.plugin': { serverIdentityId: 'local-profile' } },
    } }, { operations: [{ op: 'set', key: 'workDepthLimit', value: 4 }] }))
      .toEqual({ status: 'invalid', reason: 'invalidValue' });
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

  it('admits the bounded legacy Connected Account service-configuration root through the sole catalog', () => {
    const definition = ACCOUNT_SETTING_DEFINITIONS.connectedAccountServiceConfigurationsV1;
    expect(ACCOUNT_SETTING_KEYS).toContain('connectedAccountServiceConfigurationsV1');
    expect(definition.classification).toBe('legacy');
    expect(definition.default).toEqual({ v: 1, entries: [] });
    expect(definition.maximumSerializedValueBytes).toBe(256 * 1024);

    const value = {
      v: 1,
      entries: [connectedAccountServiceConfigurationsV1Entry()],
    };
    expect(definition.parseMutationValue(value)).toMatchObject({ success: true });
    expect(applyAccountSettingMutationV1({}, {
      operations: [{
        op: 'set',
        key: 'connectedAccountServiceConfigurationsV1',
        value,
      }],
    })).toEqual({
      status: 'applied',
      raw: { connectedAccountServiceConfigurationsV1: value },
    });
  });

  it.each([
    ['extra root key', {
      v: 1,
      entries: [connectedAccountServiceConfigurationsV1Entry()],
      future: true,
    }],
    ['extra entry key', {
      v: 1,
      entries: [connectedAccountServiceConfigurationsV1Entry({ future: true })],
    }],
    ['more than 256 entries', {
      v: 1,
      entries: Array.from({ length: 257 }, (_, index) => (
        connectedAccountServiceConfigurationsV1Entry({
          service: { pluginId: 'acme.accounts', localId: `work-${index}` },
        })
      )),
    }],
    ['duplicate service and mode target', {
      v: 1,
      entries: [
        connectedAccountServiceConfigurationsV1Entry(),
        connectedAccountServiceConfigurationsV1Entry({ revision: 'configuration-2' }),
      ],
    }],
    ['empty service plugin id', {
      v: 1,
      entries: [connectedAccountServiceConfigurationsV1Entry({
        service: { pluginId: '', localId: 'work' },
      })],
    }],
    ['oversized service local id', {
      v: 1,
      entries: [connectedAccountServiceConfigurationsV1Entry({
        service: { pluginId: 'acme.accounts', localId: 'x'.repeat(257) },
      })],
    }],
    ['extra service identity key', {
      v: 1,
      entries: [connectedAccountServiceConfigurationsV1Entry({
        service: { pluginId: 'acme.accounts', localId: 'work', future: true },
      })],
    }],
    ['empty mode id', {
      v: 1,
      entries: [connectedAccountServiceConfigurationsV1Entry({ modeId: '' })],
    }],
    ['oversized revision', {
      v: 1,
      entries: [connectedAccountServiceConfigurationsV1Entry({ revision: 'x'.repeat(257) })],
    }],
    ['non-string SavedSecret reference', {
      v: 1,
      entries: [connectedAccountServiceConfigurationsV1Entry({
        secretRefs: { clientSecret: 7 },
      })],
    }],
    ['empty SavedSecret reference', {
      v: 1,
      entries: [connectedAccountServiceConfigurationsV1Entry({
        secretRefs: { clientSecret: '' },
      })],
    }],
    ['oversized SavedSecret reference', {
      v: 1,
      entries: [connectedAccountServiceConfigurationsV1Entry({
        secretRefs: { clientSecret: 'x'.repeat(513) },
      })],
    }],
  ])('rejects invalid persisted Connected Account configuration shape: %s', (_label, value) => {
    const definition = ACCOUNT_SETTING_DEFINITIONS.connectedAccountServiceConfigurationsV1;

    expect(definition.parseMutationValue(value)).toMatchObject({ success: false });
    expect(applyAccountSettingMutationV1({}, {
      operations: [{
        op: 'set',
        key: 'connectedAccountServiceConfigurationsV1',
        value,
      }],
    })).toMatchObject({ status: 'invalid' });
  });

  it('admits Connected Account configuration members above the former private count ceiling', () => {
    const definition = ACCOUNT_SETTING_DEFINITIONS.connectedAccountServiceConfigurationsV1;
    const value = {
      v: 1,
      entries: [connectedAccountServiceConfigurationsV1Entry({
        values: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`field-${index}`, index]),
        ),
        secretRefs: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`secret-field-${index}`, `secret-${index}`]),
        ),
      })],
    };

    expect(new TextEncoder().encode(JSON.stringify(value)).byteLength)
      .toBeLessThan(definition.maximumSerializedValueBytes);
    expect(definition.parseMutationValue(value)).toMatchObject({ success: true });
    expect(applyAccountSettingMutationV1({}, {
      operations: [{
        op: 'set',
        key: 'connectedAccountServiceConfigurationsV1',
        value,
      }],
    })).toEqual({
      status: 'applied',
      raw: { connectedAccountServiceConfigurationsV1: value },
    });
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
        key: 'inferenceOpenAIKey',
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

  it('leaves Provider-owned subtree cardinality and nesting to the Provider schemas', () => {
    // The Provider settings root is the Provider owner's document. Applying the Account
    // document's generic node policy to it discards configurations Provider validation
    // accepts, so only the Account byte ceiling may refuse this root.
    let deeperThanAccountGeneric: unknown = 'leaf';
    for (let depth = 0; depth < 14; depth += 1) {
      deeperThanAccountGeneric = { child: deeperThanAccountGeneric };
    }
    const wideRecord = Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [`entry-${index}`, index]),
    );

    for (const value of [deeperThanAccountGeneric, wideRecord]) {
      const applied = applyAccountSettingMutationV1({}, {
        operations: [{ op: 'set', key: 'providerSettingsV1', value }],
      });
      expect(applied.status).toBe('applied');
      expect(applied.status === 'applied' ? applied.raw.providerSettingsV1 : null).toEqual(value);
    }

    expect(applyAccountSettingMutationV1({}, {
      operations: [{
        op: 'set',
        key: 'providerSettingsV1',
        value: { oversized: 'x'.repeat((256 * 1024) + 1) },
      }],
    })).toEqual({ status: 'invalid', reason: 'tooLarge' });
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
    const raw = { promptExternalLinksV1: 'malformed-present-root' };
    expect(applyAccountSettingMutationV1(raw, {
      operations: [{
        op: 'set',
        key: 'promptExternalLinksV1',
        value: { v: 1, links: [] },
      }],
    })).toEqual({ status: 'invalid', reason: 'invalidValue' });
    expect(raw).toEqual({ promptExternalLinksV1: 'malformed-present-root' });

    expect(applyAccountSettingMutationV1(raw, {
      operations: [{ op: 'reset', key: 'promptExternalLinksV1' }],
    })).toEqual({ status: 'applied', raw: {} });
    expect(raw).toEqual({ promptExternalLinksV1: 'malformed-present-root' });
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
