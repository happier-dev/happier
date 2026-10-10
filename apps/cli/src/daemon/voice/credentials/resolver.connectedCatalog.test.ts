import { beforeEach, describe, expect, it } from 'vitest';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { VoiceCredentialBindingIdentityV1Schema } from '@happier-dev/protocol';
import { resetActiveAccountSettingsSnapshotForTests, setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createVoiceCredentialResolver } from './resolver';

const contribution = { pluginId: 'happier.voice.test', localId: 'speech' };
const identity = VoiceCredentialBindingIdentityV1Schema.parse({ contribution, credentialSlotId: 'api_key',
  purpose: { consumer: contribution, purpose: 'voice.client-auth' } });
const target = { kind: 'account' as const, account: {
  service: { pluginId: 'happier.connected-account.test', localId: 'api' }, accountId: 'selected' } };

describe('Voice connected purpose catalog adjacency', () => {
  beforeEach(resetActiveAccountSettingsSnapshotForTests);

  it('resolves the qualified connected source from the purpose row without a Settings mirror', () => {
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'voice-account', settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], rawSettings: {},
      settings: accountSettingsParse({ voiceSettingsV1: { credentialBindings: [{ contribution,
        credentialSlotId: 'api_key', credentialSource: { kind: 'connectedAccount' }, credentialBindings: {} }] } }),
      connectedPurposeCatalog: { status: 'ready', revision: 2, record: { key: 'purposes',
        value: { v: 1, bindings: [{ purpose: identity.purpose, target }] } } } });
    expect(createVoiceCredentialResolver({ machineId: null }).resolveSelectedSource(identity)).toEqual({
      kind: 'connectedAccount', target,
    });
  });

  it('does not resolve a connected source while its catalog is unavailable', () => {
    setActiveAccountSettingsSnapshot({ source: 'network', scopeKey: 'voice-account', settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], rawSettings: {},
      settings: accountSettingsParse({ voiceSettingsV1: { credentialBindings: [{ contribution,
        credentialSlotId: 'api_key', credentialSource: { kind: 'connectedAccount' }, credentialBindings: {} }] } }),
      connectedPurposeCatalog: { status: 'unavailable', reason: 'account-mode-mismatch' } });
    expect(createVoiceCredentialResolver({ machineId: null }).resolveSelectedSource(identity)).toBeNull();
  });
});
