import { describe, expect, it } from 'vitest';

import {
  createVoiceCredentialRuntimeAuthoritySnapshot,
  createVoiceSelectedCredentialAuthorityFingerprint,
  hasVoiceCredentialRuntimeAuthorityChanged,
  readVoiceCredentialAuthorityRefs,
} from './voiceCredentialAuthorityRefs';

describe('readVoiceCredentialAuthorityRefs', () => {
  const selectedProviderId = 'happier.voice.openai/realtime-openai';
  const selectedBinding = {
    contribution: {
      pluginId: 'happier.voice.openai',
      localId: 'realtime-openai',
    },
    credentialSlotId: 'api_key',
    credentialSource: { kind: 'savedSecret' },
    credentialBindings: { account: { api_key: 'secret-openai' } },
  } as const;
  const providerEnvelope = {
    schemaVersion: 2,
    config: { voice: 'marin' },
  } as const;

  it('reads only the selected qualified contribution from canonical Voice settings', () => {
    expect(readVoiceCredentialAuthorityRefs({
      credentialBindings: [
        {
          contribution: { pluginId: 'acme.voice', localId: 'other' },
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: { account: { api_key: 'secret-other' } },
        },
        selectedBinding,
      ],
      providers: { [selectedProviderId]: providerEnvelope },
    }, selectedProviderId, 'api_key')).toEqual({
      credentialBinding: selectedBinding,
      providerEnvelope,
    });
  });

  it('does not reinterpret predecessor runtime bindings as current authority', () => {
    expect(readVoiceCredentialAuthorityRefs({
      credentialBindings: [{
        providerId: 'realtime_openai',
        credentialBindings: { account: { api_key: 'legacy-secret' } },
      }],
      providers: { realtime_openai: providerEnvelope },
    }, 'realtime_openai', 'api_key')).toEqual({
      credentialBinding: null,
      providerEnvelope: null,
    });
  });

  it('preserves the selected canonical references across unrelated settings changes', () => {
    const initial = readVoiceCredentialAuthorityRefs({
      credentialBindings: [selectedBinding],
      providers: { [selectedProviderId]: providerEnvelope },
    }, selectedProviderId, 'api_key');
    const afterUnrelatedChange = readVoiceCredentialAuthorityRefs({
      credentialBindings: [
        selectedBinding,
        {
          contribution: { pluginId: 'acme.voice', localId: 'other' },
          credentialSlotId: 'api_key',
          credentialSource: { kind: 'savedSecret' },
          credentialBindings: { account: { api_key: 'other-secret' } },
        },
      ],
      providers: {
        [selectedProviderId]: providerEnvelope,
        'acme.voice/other': { schemaVersion: 1, config: {} },
      },
    }, selectedProviderId, 'api_key');

    expect(afterUnrelatedChange.credentialBinding).toBe(initial.credentialBinding);
    expect(afterUnrelatedChange.providerEnvelope).toBe(initial.providerEnvelope);
  });

  it('matches the declaration-owned credential slot as part of the authority identity', () => {
    expect(readVoiceCredentialAuthorityRefs({
      credentialBindings: [
        {
          ...selectedBinding,
          credentialSlotId: 'retired_key',
          credentialBindings: { account: { retired_key: 'secret-retired' } },
        },
        selectedBinding,
      ],
      providers: { [selectedProviderId]: providerEnvelope },
    }, selectedProviderId, 'api_key')).toEqual({
      credentialBinding: selectedBinding,
      providerEnvelope,
    });
  });
});

describe('Voice credential runtime authority', () => {
  const runtimeBinding = {
    contribution: {
      pluginId: 'happier.voice.openai',
      localId: 'realtime-openai',
    },
    credentialSlotId: 'api_key',
    credentialSource: { kind: 'savedSecret' },
    credentialBindings: { account: { api_key: 'secret-openai' } },
  } as const;
  const runtimeProviderEnvelope = {
    schemaVersion: 2,
    config: { voice: 'marin' },
  } as const;

  it('does not rearm a connecting attempt for semantically unchanged profile projections', () => {
    const first = createVoiceCredentialRuntimeAuthoritySnapshot({
      accountScope: { serverId: 'server-1', accountId: 'account-1' },
      agentConnectedServiceBindingAuthority: 'unbound',
      credentialBinding: runtimeBinding,
      providerEnvelope: runtimeProviderEnvelope,
      selectedCredentialAuthority: 'saved-secret:secret-1:revision-1',
    });
    const refreshed = createVoiceCredentialRuntimeAuthoritySnapshot({
      accountScope: { serverId: 'server-1', accountId: 'account-1' },
      agentConnectedServiceBindingAuthority: 'unbound',
      credentialBinding: { ...runtimeBinding },
      providerEnvelope: { ...runtimeProviderEnvelope },
      selectedCredentialAuthority: 'saved-secret:secret-1:revision-1',
    });

    expect(hasVoiceCredentialRuntimeAuthorityChanged(first, refreshed)).toBe(false);
  });

  it('still rearms when the effective account or provider authority changes', () => {
    const first = createVoiceCredentialRuntimeAuthoritySnapshot({
      accountScope: { serverId: 'server-1', accountId: 'account-1' },
      agentConnectedServiceBindingAuthority: 'unbound',
      credentialBinding: runtimeBinding,
      providerEnvelope: runtimeProviderEnvelope,
      selectedCredentialAuthority: 'connected-account:profile-1:revision-1',
    });
    const changed = createVoiceCredentialRuntimeAuthoritySnapshot({
      accountScope: { serverId: 'server-1', accountId: 'account-1' },
      agentConnectedServiceBindingAuthority: 'unbound',
      credentialBinding: runtimeBinding,
      providerEnvelope: runtimeProviderEnvelope,
      selectedCredentialAuthority: 'connected-account:profile-2:revision-2',
    });

    expect(hasVoiceCredentialRuntimeAuthorityChanged(first, changed)).toBe(true);
  });

  it('ignores unrelated credential collections after canonical selection', () => {
    const selected = createVoiceSelectedCredentialAuthorityFingerprint({
      sourceResolution: { selection: { kind: 'savedSecret' }, savedSecret: { secretId: 'selected' } },
      selectedSavedSecret: { id: 'selected', updatedAt: 2 },
      selectedConnectedAccountAuthority: 'unbound',
    });
    const afterUnrelatedChange = createVoiceSelectedCredentialAuthorityFingerprint({
      sourceResolution: { selection: { kind: 'savedSecret' }, savedSecret: { secretId: 'selected' } },
      selectedSavedSecret: { id: 'selected', updatedAt: 2 },
      selectedConnectedAccountAuthority: 'unbound',
    });
    expect(afterUnrelatedChange).toBe(selected);
  });
});
