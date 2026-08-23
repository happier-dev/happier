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
    ['more than 64 SavedSecret references', {
      v: 1,
      entries: [connectedAccountServiceConfigurationsV1Entry({
        secretRefs: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`field-${index}`, `secret-${index}`]),
        ),
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
