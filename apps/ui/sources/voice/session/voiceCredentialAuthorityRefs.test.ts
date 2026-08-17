import { describe, expect, it } from 'vitest';

import {
  createVoiceCredentialRuntimeAuthoritySnapshot,
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
      connectedServiceCredentialRevisions: { openai: 2 },
      connectedServices: [{ serviceId: 'openai-codex', profiles: [{ profileId: 'profile-1' }] }],
      credentialBinding: runtimeBinding,
      providerEnvelope: runtimeProviderEnvelope,
      secrets: [{ id: 'secret-1', value: 'ciphertext' }],
    });
    const refreshed = createVoiceCredentialRuntimeAuthoritySnapshot({
      accountScope: { serverId: 'server-1', accountId: 'account-1' },
      agentConnectedServiceBindingAuthority: 'unbound',
      connectedServiceCredentialRevisions: { openai: 2 },
      connectedServices: [{ serviceId: 'openai-codex', profiles: [{ profileId: 'profile-1' }] }],
      credentialBinding: { ...runtimeBinding },
      providerEnvelope: { ...runtimeProviderEnvelope },
      secrets: [{ id: 'secret-1', value: 'ciphertext' }],
    });

    expect(hasVoiceCredentialRuntimeAuthorityChanged(first, refreshed)).toBe(false);
  });

  it('still rearms when the effective account or provider authority changes', () => {
    const first = createVoiceCredentialRuntimeAuthoritySnapshot({
      accountScope: { serverId: 'server-1', accountId: 'account-1' },
      agentConnectedServiceBindingAuthority: 'unbound',
      connectedServiceCredentialRevisions: null,
      connectedServices: [{ serviceId: 'openai-codex', activeProfileId: 'profile-1' }],
      credentialBinding: runtimeBinding,
      providerEnvelope: runtimeProviderEnvelope,
      secrets: [],
    });
    const changed = createVoiceCredentialRuntimeAuthoritySnapshot({
      accountScope: { serverId: 'server-1', accountId: 'account-1' },
      agentConnectedServiceBindingAuthority: 'unbound',
      connectedServiceCredentialRevisions: null,
      connectedServices: [{ serviceId: 'openai-codex', activeProfileId: 'profile-2' }],
      credentialBinding: runtimeBinding,
      providerEnvelope: runtimeProviderEnvelope,
      secrets: [],
    });

    expect(hasVoiceCredentialRuntimeAuthorityChanged(first, changed)).toBe(true);
  });
});
