import { describe, expect, it } from 'vitest';
import { resolveAgentConnectedServicesDefaultBindings } from '@/sync/domains/connectedServices/resolveAgentConnectedServicesDefaultBindings';
import { resolveAgentCatalogProjection } from '@/agents/backendCatalog/agentCatalogProjection';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

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

  it('projects retired stored fields without changing selected credential authority', () => {
    const refs = readVoiceCredentialAuthorityRefs({ credentialBindings: [{ ...selectedBinding, retired: true,
      contribution: { ...selectedBinding.contribution, retired: true },
      credentialSource: { ...selectedBinding.credentialSource, retired: true },
      credentialBindings: { ...selectedBinding.credentialBindings, retired: true } }],
      providers: { [selectedProviderId]: { ...providerEnvelope, retired: true } },
    }, selectedProviderId, 'api_key');
    expect(refs).toEqual({ credentialBinding: selectedBinding, providerEnvelope });
    expect(readVoiceCredentialAuthorityRefs({ credentialBindings: [{ ...selectedBinding,
      credentialSource: { kind: 'retired' } }], providers: { [selectedProviderId]: providerEnvelope },
    }, selectedProviderId, 'api_key').credentialBinding).toBeNull();
  });

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
  it('observes the fixed Agent effective purpose default and ignores other Agents defaults', () => {
    const consumer = { pluginId: 'happier.agent.codex', localId: 'codex' };
    const agent = resolveAgentCatalogProjection('codex', { enabledAgentIds: [] });
    const declaration = agent.connectedAccounts[0];
    if (!declaration) throw new Error('Codex connected-account declaration missing');
    const binding = (localId: string) => ({ purpose: { consumer: { pluginId: `happier.agent.${localId}`, localId }, purpose: declaration.purpose },
      target: { kind: 'group' as const, service: declaration.service, groupId: 'work-pool' } });
    const authority = (bindings: ReturnType<typeof binding>[]) => createVoiceCredentialRuntimeAuthoritySnapshot({
      accountScope: { serverId: 'server-1', accountId: 'account-1' },
      agentConnectedServiceBindingAuthority: 'unbound', credentialBinding: null,
      providerEnvelope: null, selectedCredentialAuthority: 'unbound',
      agentDefaultAuthority: stableJsonStringify(resolveAgentConnectedServicesDefaultBindings({
        consumer, declarations: agent.connectedAccounts, purposeBindings: { v: 1, bindings } })),
    });
    expect(hasVoiceCredentialRuntimeAuthorityChanged(authority([]), authority([binding('claude')]))).toBe(false);
    expect(hasVoiceCredentialRuntimeAuthorityChanged(authority([]), authority([binding('codex')]))).toBe(true);
  });
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
});
