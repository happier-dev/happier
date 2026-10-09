import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
  isRetiredAccountSettingsRootKey,
} from './accountSettings.js';
import { applyAccountSettingsHistoryRestoreV1, normalizeTransferredAccountSettingsHistoryV1 } from './accountSettingsHistoryRestoreV1.js';
import { AccountSettingsHistorySavedSecretTransferV1Schema } from './accountSettingsApiV2.js';

describe('normalizeTransferredAccountSettingsHistoryV1', () => {
  it('retires only the actually activated prompt surface and keeps untransferred Profile and Voice history', () => {
    const raw = { promptFoldersV1: { v: 1, folders: [{ id: 'old', name: 'Old' }] }, promptStacksV1: { v: 1, surfaces: {
      coding: [{ id: 'old-coding' }], voice: [{ id: 'retained-voice' }], profilesById: { private: [{ id: 'retained-profile' }] },
    } }, preferredLanguage: 'de' };
    expect(normalizeTransferredAccountSettingsHistoryV1(raw, { activeTransferredRoots: [],
      activePromptLibraryKeys: ['coding', 'folders'] })).toEqual({ status: 'applied', raw: { promptStacksV1: { v: 1, surfaces: {
        voice: raw.promptStacksV1.surfaces.voice, profilesById: raw.promptStacksV1.surfaces.profilesById,
      } }, preferredLanguage: 'de' } });
  });
  it('removes activated Profile preference residue through the Profile source owner', () => {
    const raw = { profiles: [{ id: 'custom' }], profileEnabledById: { custom: false, unrelated: true },
      promptStacksV1: { v: 1, surfaces: { profilesById: { custom: { retainedCredential: 'fixture' } }, other: { keep: true } } },
      futurePreference: { keep: true } };
    expect(normalizeTransferredAccountSettingsHistoryV1(raw, { activeTransferredRoots: ['profiles', 'secretBindingsByProfileId'],
      activeTransferredProfileIds: ['custom'] })).toEqual({ status: 'applied', raw: {
      profileEnabledById: { unrelated: true }, promptStacksV1: { v: 1, surfaces: { other: { keep: true } } }, futurePreference: { keep: true },
    } });
  });
  it('removes only active destination roots, preserving the recorded preference and unknown document', () => {
    const raw = { profiles: [{ id: 'legacy' }], secrets: [{ id: 'sensitive' }], preferredLanguage: 'de',
      futurePreference: { opaque: true }, schemaVersion: 0 };
    expect(normalizeTransferredAccountSettingsHistoryV1(raw, { activeTransferredRoots: ['profiles', 'secrets'] })).toEqual({
      status: 'applied', cleanupPending: true, raw: { secrets: raw.secrets, preferredLanguage: 'de', futurePreference: { opaque: true }, schemaVersion: 0 },
    });
    expect(raw.profiles).toEqual([{ id: 'legacy' }]);
    expect(normalizeTransferredAccountSettingsHistoryV1(raw, { activeTransferredRoots: [] })).toEqual({ status: 'unchanged', cleanupPending: true, raw });
  });
  it('removes only proved migrated SavedSecret items and retains other or unrecognized entries', () => {
    const migrated = { id: 'migrated', name: 'Old', kind: 'apiKey', encryptedValue: { _isSecretValue: true, value: 'old-fixture' }, createdAt: 1, updatedAt: 1 };
    const retained = { ...migrated, id: 'retained' };
    const unknown = { ...migrated, id: 'migrated', future: true };
    const nestedFuture = { ...migrated, encryptedValue: { ...migrated.encryptedValue, futureCredential: 'retain-fixture' } };
    expect(normalizeTransferredAccountSettingsHistoryV1({ secrets: [migrated, retained, unknown, nestedFuture] }, {
      activeTransferredRoots: [], savedSecretTransfers: [{ savedSecretId: 'migrated', resourceId: 'resource', expectedRevision: 1 }],
    })).toEqual({ status: 'applied', cleanupPending: true, raw: { secrets: [retained, unknown, nestedFuture] } });
    expect(normalizeTransferredAccountSettingsHistoryV1({ secrets: [migrated] }, {
      activeTransferredRoots: [], savedSecretTransfers: [{ savedSecretId: 'migrated', resourceId: 'resource', expectedRevision: 1 }],
    })).toEqual({ status: 'applied', raw: { secrets: [] } });
  });
  it.each([null, 'unrecognized-secret-container', { futureCredential: 'retain-fixture' }])(
    'preserves an unrecognized SavedSecret root and reports incomplete cleanup', secrets => {
      const raw = { secrets, futurePreference: true };
      expect(normalizeTransferredAccountSettingsHistoryV1(raw, { activeTransferredRoots: [],
        savedSecretTransfers: [{ savedSecretId: 'migrated', resourceId: 'resource', expectedRevision: 1 }],
      })).toEqual({ status: 'unchanged', cleanupPending: true, raw });
    },
  );
  it('retains the characterized bare inference credential and keeps sensitive history cleanup pending', () => {
    const raw = { inferenceOpenAIKey: 'legacy-inference-fixture', preferredLanguage: 'de' };
    expect(normalizeTransferredAccountSettingsHistoryV1(raw, { activeTransferredRoots: [] }))
      .toEqual({ status: 'unchanged', cleanupPending: true, raw });
  });
  it('cleans only the characterized inference root under a closed destination-source proof', () => {
    const input = { source: { kind: 'legacy-inference-openai-key' }, resourceId: 'inference-resource', expectedRevision: 3 };
    const parsed = AccountSettingsHistorySavedSecretTransferV1Schema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error('missing_inference_history_proof');
    const authority = { activeTransferredRoots: [], savedSecretTransfers: [parsed.data] };
    const raw = { inferenceOpenAIKey: 'old-private-inference-fixture', preferredLanguage: 'de', futurePreference: { retained: true } };
    expect(normalizeTransferredAccountSettingsHistoryV1(raw, authority)).toEqual({ status: 'applied',
      raw: { preferredLanguage: 'de', futurePreference: raw.futurePreference } });
    const uncharacterized = { ...raw, inferenceOpenAIKey: { futureCredential: 'retain-fixture' } };
    expect(normalizeTransferredAccountSettingsHistoryV1(uncharacterized, authority))
      .toEqual({ status: 'unchanged', cleanupPending: true, raw: uncharacterized });
    expect(AccountSettingsHistorySavedSecretTransferV1Schema.safeParse({ ...input, savedSecretId: 'invented' }).success).toBe(false);
    expect(AccountSettingsHistorySavedSecretTransferV1Schema.safeParse({ ...input,
      source: { ...input.source, futureCredential: true } }).success).toBe(false);
  });
});

describe('applyAccountSettingsHistoryRestoreV1', () => {
  it('never carries an activated destination root from the latest or historical source', () => {
    expect(applyAccountSettingsHistoryRestoreV1({
      secrets: [], profiles: [{ id: 'stale-source' }], futureLatest: { retained: true },
    }, {
      secrets: [], profiles: [{ id: 'historical-source' }], futureHistorical: true,
      preferredLanguage: 'de',
    }, { activeTransferredRoots: ['secrets', 'profiles'] })).toEqual({
      status: 'applied',
      raw: { secrets: [], preferredLanguage: 'de', futureLatest: { retained: true }, schemaVersion: ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION },
    });
  });
  it('keeps the latest-only inference alias and never imports a historical credential copy', () => {
    expect(applyAccountSettingsHistoryRestoreV1({ inferenceOpenAIKey: 'latest-inference-fixture' },
      { inferenceOpenAIKey: 'historic-inference-fixture', preferredLanguage: 'de' })).toEqual({ status: 'applied',
        raw: { inferenceOpenAIKey: 'latest-inference-fixture', preferredLanguage: 'de', schemaVersion: ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION } });
    expect(applyAccountSettingsHistoryRestoreV1({}, { inferenceOpenAIKey: 'historic-inference-fixture' })).toEqual({ status: 'applied',
      raw: { schemaVersion: ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION } });
  });
  it('restores preference roots from history, carries legacy and supported-future roots from the latest baseline, and excludes retired roots', () => {
    const latest = {
      sessionTmuxSessionName: 'new-name',
      preferredLanguage: 'en',
      profiles: [{ id: 'profile-current' }],
      pluginSecretStateV1: { supportedFutureRoot: true },
      pinnedSessionKeysV1: ['retired-key'],
      schemaVersion: 2,
    };
    const historical = {
      sessionTmuxSessionName: 'old-name',
      preferredLanguage: 'de',
      profiles: [{ id: 'profile-ancient' }],
      unknownHistoricalKey: { never: 'resurrect' },
      pinnedSessionKeysV1: ['historic-key'],
      schemaVersion: 0,
    };

    expect(applyAccountSettingsHistoryRestoreV1(latest, historical)).toEqual({
      status: 'applied',
      raw: {
        sessionTmuxSessionName: 'old-name',
        preferredLanguage: 'de',
        profiles: [{ id: 'profile-current' }],
        pluginSecretStateV1: { supportedFutureRoot: true },
        schemaVersion: ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
      },
    });
  });

  it('resets a preference the historical snapshot omits but keeps a legacy root it omits', () => {
    const latest = {
      preferredLanguage: 'en',
      profiles: [{ id: 'profile-current' }],
    };

    const application = applyAccountSettingsHistoryRestoreV1(latest, {});
    expect(application.status).toBe('applied');
    if (application.status === 'invalid') throw new Error('expected an applied restore');
    expect(Object.hasOwn(application.raw, 'preferredLanguage')).toBe(false);
    expect(application.raw.profiles).toEqual([{ id: 'profile-current' }]);
  });

  it('keeps the latest secrets and connected-account bindings instead of rewinding historical copies', () => {
    const latestSecret = {
      id: 'secret-current',
      name: 'Current',
      kind: 'apiKey' as const,
      encryptedValue: {
        _isSecretValue: true as const,
        encryptedValue: { t: 'enc-v1' as const, c: 'ciphertext-current' },
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const historicalSecret = {
      ...latestSecret,
      id: 'secret-historical',
      name: 'Historical',
      encryptedValue: {
        _isSecretValue: true as const,
        encryptedValue: { t: 'enc-v1' as const, c: 'ciphertext-historical' },
      },
      updatedAt: 1,
    };
    const latestBindings = {
      v: 1 as const,
      bindings: [{
        purpose: {
          consumer: { pluginId: 'happier.agent.current', localId: 'runtime' },
          purpose: 'model-request',
        },
        target: {
          kind: 'group' as const,
          service: { pluginId: 'happier.connected-account.current', localId: 'subscription' },
          groupId: 'current',
        },
      }],
    };
    const historicalBindings = {
      v: 1 as const,
      bindings: [{
        purpose: {
          consumer: { pluginId: 'happier.agent.historical', localId: 'runtime' },
          purpose: 'model-request',
        },
        target: {
          kind: 'group' as const,
          service: { pluginId: 'happier.connected-account.historical', localId: 'subscription' },
          groupId: 'historical',
        },
      }],
    };

    const application = applyAccountSettingsHistoryRestoreV1({
      secrets: [latestSecret],
      secretBindingsByProfileId: { current: { API_KEY: latestSecret.id } },
      connectedAccountPurposeBindingsV1: latestBindings,
    }, {
      secrets: [historicalSecret],
      secretBindingsByProfileId: { historical: { API_KEY: historicalSecret.id } },
      connectedAccountPurposeBindingsV1: historicalBindings,
    });

    expect(application.status).toBe('applied');
    if (application.status === 'invalid') throw new Error('expected an applied restore');
    expect(application.raw.secrets).toEqual([latestSecret]);
    expect(application.raw.secretBindingsByProfileId).toEqual({ current: { API_KEY: latestSecret.id } });
    expect(application.raw.connectedAccountPurposeBindingsV1).toEqual(latestBindings);
  });

  it('reports unchanged without producing a new document when history equals the baseline', () => {
    const latest = {
      sessionTmuxSessionName: 'same',
      schemaVersion: ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
    };
    expect(applyAccountSettingsHistoryRestoreV1(latest, {
      sessionTmuxSessionName: 'same',
      schemaVersion: 0,
    })).toEqual({
      status: 'unchanged',
      raw: { sessionTmuxSessionName: 'same', schemaVersion: ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION },
    });
  });

  it('fails typed when a historical preference value cannot satisfy its current schema', () => {
    const application = applyAccountSettingsHistoryRestoreV1(
      { preferredLanguage: 'en' },
      { preferredLanguage: 42 },
    );
    expect(application).toEqual({ status: 'invalid', reason: 'invalidValue' });
  });

  it('fails typed when the merged document would exceed the canonical document ceiling', () => {
    const application = applyAccountSettingsHistoryRestoreV1(
      { supportedFutureOversize: 'x'.repeat(600 * 1024) },
      {},
    );
    expect(application).toEqual({ status: 'invalid', reason: 'tooLarge' });
  });

  it.each([
    ['a null snapshot', null],
    ['an array snapshot', ['not', 'a', 'record']],
    ['a string snapshot', 'not-a-record'],
  ])('fails typed for %s', (_name, historicalRaw) => {
    expect(applyAccountSettingsHistoryRestoreV1({}, historicalRaw)).toEqual({
      status: 'invalid',
      reason: 'contentUnreadable',
    });
  });

  it('never resurrects a retired root carried only by history', () => {
    expect(isRetiredAccountSettingsRootKey('pinnedSessionKeysV1')).toBe(true);
    const application = applyAccountSettingsHistoryRestoreV1(
      {},
      { pinnedSessionKeysV1: ['historic'] },
    );
    expect(application.status).toBe('applied');
    if (application.status === 'invalid') throw new Error('expected an applied restore');
    expect(Object.hasOwn(application.raw, 'pinnedSessionKeysV1')).toBe(false);
  });
});
