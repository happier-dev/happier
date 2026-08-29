import { describe, expect, it } from 'vitest';

import {
  ACCOUNT_SETTINGS_SUPPORTED_SCHEMA_VERSION,
  isRetiredAccountSettingsRootKey,
} from './accountSettings.js';
import { applyAccountSettingsHistoryRestoreV1 } from './accountSettingsHistoryRestoreV1.js';

describe('applyAccountSettingsHistoryRestoreV1', () => {
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
