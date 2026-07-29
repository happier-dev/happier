import { describe, expect, it, vi } from 'vitest';

import { settingsParse } from '@/sync/domains/settings/settings';
import {
  approveAccountVoiceCredentialRecipientContract,
  materializeAccountVoiceCredential,
  removeAccountVoiceCredential,
  resolveAccountVoiceCredential,
  upsertAccountVoiceCredential,
} from './accountVoiceCredential';

describe('account Voice credential ownership', () => {
  it('saves and changes one account binding without machine affinity', () => {
    const initial = settingsParse({});
    const created = upsertAccountVoiceCredential({
      settings: initial,
      providerId: 'realtime_openai',
      credentialSlotId: 'api_key',
      value: 'sk-first',
      generateId: () => 'voice-openai-secret',
      now: 10,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    });
    expect(resolveAccountVoiceCredential(created.settings, 'realtime_openai', 'api_key', 'machine-a')).toEqual({
      secretId: 'voice-openai-secret', source: 'account',
    });

    const changed = upsertAccountVoiceCredential({
      settings: created.settings,
      providerId: 'realtime_openai',
      credentialSlotId: 'api_key',
      value: 'sk-second',
      generateId: () => 'voice-openai-secret-next',
      now: 20,
      expectedSecretId: 'voice-openai-secret',
      expectedSecretUpdatedAt: 10,
    });
    expect(changed.settings.secrets).toEqual([expect.objectContaining({
      id: 'voice-openai-secret-next',
      encryptedValue: { _isSecretValue: true, value: 'sk-second' },
      createdAt: 20,
      updatedAt: 20,
    })]);
  });

  it('preserves the selected external provider and config when recipient approval is renewed', () => {
    const providerId = 'acme.packed-voice/conversation';
    const providerEnvelope = {
      schemaVersion: 2,
      config: {
        mode: 'default',
        profile: 'balanced',
        enableProvisioning: true,
      },
    };
    const recipientContractBefore = `sha256:${'a'.repeat(64)}`;
    const recipientContractAfter = `sha256:${'b'.repeat(64)}`;
    const credentialCreated = upsertAccountVoiceCredential({
      settings: settingsParse({}),
      providerId,
      credentialSlotId: 'api_key',
      value: 'source-account-secret',
      generateId: () => 'packed-voice-secret',
      now: 1,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
      approvedRecipientContractDigest: recipientContractBefore,
    }).settings;
    const initial = {
      ...credentialCreated,
      voice: {
        ...credentialCreated.voice,
        providerId,
        providers: {
          ...credentialCreated.voice.providers,
          [providerId]: providerEnvelope,
        },
      },
      voiceSettingsV1: {
        ...credentialCreated.voiceSettingsV1,
        providerId,
        providers: {
          ...credentialCreated.voiceSettingsV1.providers,
          [providerId]: providerEnvelope,
        },
      },
    };

    const changed = upsertAccountVoiceCredential({
      settings: initial,
      providerId,
      credentialSlotId: 'api_key',
      value: 'source-account-secret',
      generateId: () => 'packed-voice-secret-reapproved',
      now: 2,
      expectedSecretId: 'packed-voice-secret',
      expectedSecretUpdatedAt: 1,
      approvedRecipientContractDigest: recipientContractAfter,
    });

    expect(changed.settings.voice).toMatchObject({
      providerId,
      providers: {
        [providerId]: providerEnvelope,
      },
      credentialBindings: [{
        providerId,
        approvedRecipientContractDigest: recipientContractAfter,
        credentialBindings: {
          account: { api_key: 'packed-voice-secret-reapproved' },
        },
      }],
    });
    expect(changed.settings.voiceSettingsV1).toMatchObject({
      providerId,
      providers: {
        [providerId]: providerEnvelope,
      },
    });
  });

  it('renews recipient approval in place without rotating the selected secret', () => {
    const created = upsertAccountVoiceCredential({
      settings: settingsParse({}),
      providerId: 'acme.packed-voice/conversation',
      credentialSlotId: 'api_key',
      value: 'source-account-secret',
      generateId: () => 'packed-voice-secret',
      now: 1,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
      approvedRecipientContractDigest: `sha256:${'a'.repeat(64)}`,
    }).settings;

    const approved = approveAccountVoiceCredentialRecipientContract({
      settings: created,
      providerId: 'acme.packed-voice/conversation',
      credentialSlotId: 'api_key',
      expectedSecretId: 'packed-voice-secret',
      expectedSecretUpdatedAt: 1,
      approvedRecipientContractDigest: `sha256:${'b'.repeat(64)}`,
    });

    expect(approved.settings.secrets).toEqual(created.secrets);
    expect(resolveAccountVoiceCredential(
      approved.settings,
      'acme.packed-voice/conversation',
      'api_key',
      null,
      `sha256:${'b'.repeat(64)}`,
    )).toEqual({ secretId: 'packed-voice-secret', source: 'account' });
  });

  it('resolves an exact machine override before account fallback', () => {
    const settings = settingsParse({
      secrets: [
        { id: 'account-secret', name: 'Account', kind: 'apiKey', encryptedValue: { _isSecretValue: true, value: 'account' }, createdAt: 1, updatedAt: 1 },
        { id: 'machine-secret', name: 'Machine', kind: 'apiKey', encryptedValue: { _isSecretValue: true, value: 'machine' }, createdAt: 1, updatedAt: 1 },
      ],
      voice: {
        credentialBindings: [{
          providerId: 'google_gemini',
          credentialBindings: {
            account: { api_key: 'account-secret' },
            byMachineId: { 'machine-a': { api_key: 'machine-secret' } },
          },
        }],
      },
    });
    expect(resolveAccountVoiceCredential(settings, 'google_gemini', 'api_key', 'machine-a')?.source).toBe('machine_override');
    expect(resolveAccountVoiceCredential(settings, 'google_gemini', 'api_key', 'machine-b')?.source).toBe('account');
  });

  it('materializes only through the invocation-scoped decrypt callback', () => {
    const settings = upsertAccountVoiceCredential({
      settings: settingsParse({}), providerId: 'realtime_grok', credentialSlotId: 'api_key',
      value: 'xai-key', generateId: () => 'xai-secret', now: 1, expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    }).settings;
    const decrypt = vi.fn(() => 'xai-key');
    expect(materializeAccountVoiceCredential({ settings, providerId: 'realtime_grok', credentialSlotId: 'api_key', decrypt })).toBe('xai-key');
    expect(decrypt).toHaveBeenCalledOnce();
  });

  it('unbinds and deletes only an otherwise unreferenced SavedSecret', () => {
    const created = upsertAccountVoiceCredential({
      settings: settingsParse({}), providerId: 'realtime_openai', credentialSlotId: 'api_key',
      value: 'shared', generateId: () => 'shared-secret', now: 1, expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    }).settings;
    const shared = {
      ...created,
      secretBindingsByProfileId: { profile: { OPENAI_API_KEY: 'shared-secret' } },
    };
    expect(removeAccountVoiceCredential({
      settings: shared,
      providerId: 'realtime_openai',
      credentialSlotId: 'api_key',
      expectedSecretId: 'shared-secret',
      expectedSecretUpdatedAt: 1,
    }).settings.secrets)
      .toHaveLength(1);
    expect(removeAccountVoiceCredential({
      settings: created,
      providerId: 'realtime_openai',
      credentialSlotId: 'api_key',
      expectedSecretId: 'shared-secret',
      expectedSecretUpdatedAt: 1,
    }).settings.secrets)
      .toEqual([]);
  });

  it('rejects a stale target-local Voice replacement instead of overwriting the CAS winner', () => {
    const current = upsertAccountVoiceCredential({
      settings: settingsParse({}),
      providerId: 'realtime_openai',
      credentialSlotId: 'api_key',
      value: 'winner',
      generateId: () => 'winner-secret',
      now: 1,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    }).settings;

    expect(() => upsertAccountVoiceCredential({
      settings: current,
      providerId: 'realtime_openai',
      credentialSlotId: 'api_key',
      value: 'stale',
      generateId: () => 'stale-secret',
      now: 2,
      expectedSecretId: null,
      expectedSecretUpdatedAt: null,
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_conflict' }));

    expect(() => upsertAccountVoiceCredential({
      settings: current,
      providerId: 'realtime_openai',
      credentialSlotId: 'api_key',
      value: 'stale-after-global-rotation',
      generateId: () => 'stale-after-rotation-secret',
      now: 2,
      expectedSecretId: 'winner-secret',
      expectedSecretUpdatedAt: 0,
    })).toThrowError(expect.objectContaining({ code: 'saved_secret_conflict' }));
  });
});
