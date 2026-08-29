import { describe, expect, it } from 'vitest';
import {
  buildQualifiedPluginContributionKey,
  createPluginContributionIdentity,
} from '@happier-dev/protocol';

import { getBundledVoiceProviderEntry } from '@/voice/registry/internalContributions';
import {
  BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS,
} from '@/voice/registry/generatedBundledVoiceEntries';
import { VoiceLocalConversationSchema } from '@/voice/adapters/localConversation/settings';
import { createVoiceProviderSettingsCatalog } from './providerSettings';

describe('voice provider settings catalog', () => {
  const codexProviderId = buildQualifiedPluginContributionKey(createPluginContributionIdentity({
    pluginId: 'happier.agent.codex',
    localId: 'realtime-codex',
  }));
  const elevenLabsProviderId = 'happier.voice.elevenlabs/realtime-elevenlabs';
  const bundledCatalogInput = Object.freeze({
    bundledContributions: BUNDLED_FIRST_PARTY_VOICE_CONTRIBUTIONS,
  });
  const emptyBundledCatalogInput = Object.freeze({
    bundledContributions: Object.freeze([]),
  });
  it('uses public bundled settings for current parsing without granting presentation callbacks persistence authority', () => {
    const catalog = createVoiceProviderSettingsCatalog({
      bundledContributions: [{
        pluginId: 'happier.voice.fixture',
        providerId: 'happier.voice.fixture/public-settings-fixture',
        declaration: {
          id: 'public-settings-fixture',
          title: 'Public settings fixture',
          kind: 'conversation',
          roles: ['realtime_conversation'],
          platforms: ['web'],
          capabilities: {
            turn: { cancelResponse: false, bargeIn: false },
            tools: { effectCalls: 'none' },
          },
          settings: {
            schemaVersion: 2,
            fields: [{
              id: 'billingMode',
              title: 'Billing mode',
              schema: { type: 'string', enum: ['hosted', 'byo'] },
              default: 'hosted',
              presentation: {
                control: 'select',
                options: [
                  { value: 'hosted', title: 'Hosted' },
                  { value: 'byo', title: 'BYO' },
                ],
              },
            }],
          },
          client: {
            artifactId: 'client',
            modulePath: './voiceRuntime',
            exportName: 'activate',
          },
        },
      }],
    });
    const owner = catalog.get('happier.voice.fixture/public-settings-fixture')!;

    expect(owner.defaultConfig).toEqual({ billingMode: 'hosted' });
    expect(owner.parseConfig({ billingMode: 'byo' })).toEqual({ billingMode: 'byo' });
    expect(owner.parseConfig({ mode: 'default', billingMode: 'byo', extra: true })).toBeNull();
    expect(owner.parseConfig({ mode: 'default', billingMode: 'byo' })).toBeNull();
    expect(owner.migrateLegacy({ legacy: true })).toBeNull();
  });

  it('removes bundled settings behavior when disabled and restores it without retaining stale state', () => {
    const enabled = createVoiceProviderSettingsCatalog(bundledCatalogInput);
    const disabled = createVoiceProviderSettingsCatalog(emptyBundledCatalogInput);
    const reEnabled = createVoiceProviderSettingsCatalog(bundledCatalogInput);

    expect(enabled.get(elevenLabsProviderId)?.defaultConfig).toMatchObject({ billingMode: 'happier' });
    expect(disabled.get(elevenLabsProviderId)).toBeNull();
    expect(disabled.defaultEnvelopes()).not.toHaveProperty(elevenLabsProviderId);
    expect(reEnabled.get(elevenLabsProviderId)?.defaultConfig).toEqual(
      enabled.get(elevenLabsProviderId)?.defaultConfig,
    );
    expect(reEnabled.get(elevenLabsProviderId)).not.toBe(enabled.get(elevenLabsProviderId));
  });

  it('keeps the released ElevenLabs translator at the fixed Account Settings owner', () => {
    const owner = createVoiceProviderSettingsCatalog(bundledCatalogInput).get(elevenLabsProviderId);
    if (!owner) throw new Error('expected_released_elevenlabs_compatibility_owner');
    const migrated = owner.migrateLegacy({
      assistantLanguage: 'fr',
      billingMode: 'byo',
      byo: { agentId: 'agent_1', apiKey: { _isSecretValue: true, value: 'xi_legacy' } },
      welcome: { enabled: true, mode: 'on_first_turn', templateId: 'hello' },
      tts: { voiceSettings: { style: 0.35, useSpeakerBoost: true, speed: 0.6 } },
    });

    expect(owner.defaultLegacyConfig).toMatchObject({
      tts: { voiceId: 'EST9Ui6982FZPSi7gCHi' },
    });
    expect(migrated).toMatchObject({
      config: { billingMode: 'byo', agentId: 'agent_1', tts: { voiceSettings: { speed: null } } },
      root: {
        assistantLanguage: 'fr',
        welcome: { enabled: true, mode: 'on_first_turn', templateId: 'hello' },
      },
    });
    expect((migrated?.config as any).tts.voiceSettings).not.toHaveProperty('style');
    expect((migrated?.config as any).tts.voiceSettings).not.toHaveProperty('useSpeakerBoost');
    expect(JSON.stringify(migrated?.config)).not.toContain('xi_legacy');
  });

  it('keeps built-in settings owners available independently of bundled packages', () => {
    const disabled = createVoiceProviderSettingsCatalog(emptyBundledCatalogInput);
    expect(disabled.get('local_direct')).not.toBeNull();
    expect(disabled.get('local_conversation')).not.toBeNull();
  });

  it('retains canonical Provider Chat state while applying a predecessor Local Conversation write', () => {
    const catalog = createVoiceProviderSettingsCatalog(emptyBundledCatalogInput);
    const owner = catalog.get('local_conversation');
    if (!owner) throw new Error('expected_local_conversation_owner');
    const canonical = VoiceLocalConversationSchema.parse({
      agent: {
        agentSource: 'session',
        agentId: 'claude',
        providerChat: {
          status: 'migration_required',
          reason: 'invalid_legacy_configuration',
        },
      },
    });
    const predecessor = owner.migrateLegacy({
      conversationMode: 'agent',
      networkTimeoutMs: 32_000,
      agent: {
        // `providerChat` is absent from the released predecessor shape.
        // Its declared agent selection remains predecessor-owned, however.
        agentSource: 'agent',
        agentId: 'opencode',
      },
    });
    if (!predecessor) throw new Error('expected_predecessor_local_conversation_config');

    expect(owner.mergeLegacy(canonical, predecessor.config)).toMatchObject({
      networkTimeoutMs: 32_000,
      agent: {
        agentSource: 'agent',
        agentId: 'opencode',
        providerChat: {
          status: 'migration_required',
          reason: 'invalid_legacy_configuration',
        },
      },
    });
  });

  it.each([
    {
      selection: 'profile',
      selectedBinding: {
        source: 'connected' as const,
        selection: 'profile' as const,
        profileId: 'codex-account-a',
      },
    },
    {
      selection: 'group',
      selectedBinding: {
        source: 'connected' as const,
        selection: 'group' as const,
        groupId: 'codex-team-a',
      },
    },
  ])('persists the bundled Codex global $selection binding as the sole version-two provider config', ({
    selectedBinding,
  }) => {
    const catalog = createVoiceProviderSettingsCatalog(bundledCatalogInput);
    const owner = catalog.get(codexProviderId);
    const bundledEntry = getBundledVoiceProviderEntry(codexProviderId);
    const binding = {
      v: 1 as const,
      bindingsByServiceId: {
        'openai-codex': selectedBinding,
      },
    };

    expect(owner).toMatchObject({
      currentSchemaVersion: 2,
      defaultConfig: { globalConnectedServices: null },
    });
    expect(bundledEntry?.kind === 'voice.conversation-provider.v1'
      ? bundledEntry.presentation
      : null).not.toHaveProperty('providerSettings');
    expect(owner?.migrateLegacy({})).toBeNull();
    expect(owner?.parseConfig({ globalConnectedServices: binding })).toEqual({
      globalConnectedServices: binding,
    });
    expect(owner?.parseConfig({
      globalConnectedServices: binding,
      accessToken: 'must-not-be-persisted',
    })).toBeNull();
  });

  it.each([
    {
      selection: 'profile',
      selectedBinding: {
        source: 'connected' as const,
        selection: 'profile' as const,
        profileId: 'codex-account-a',
        accessToken: 'must-not-be-persisted',
      },
    },
    {
      selection: 'group',
      selectedBinding: {
        source: 'connected' as const,
        selection: 'group' as const,
        groupId: 'codex-team-a',
        accessToken: 'must-not-be-persisted',
      },
    },
  ])('rejects a bundled Codex $selection binding with a nested non-canonical secret field', ({
    selectedBinding,
  }) => {
    const catalog = createVoiceProviderSettingsCatalog(bundledCatalogInput);
    const owner = catalog.get(codexProviderId);

    expect(owner?.parseConfig({
      globalConnectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': selectedBinding,
        },
      },
    })).toBeNull();
  });

  it('projects predecessor-supported local settings and the exact OpenAI-compatible sidecar into the pinned remote-dev adapter shape', () => {
    const catalog = createVoiceProviderSettingsCatalog(emptyBundledCatalogInput);
    const localDirect = catalog.get('local_direct');
    const localConversation = catalog.get('local_conversation');

    const direct = localDirect?.projectLegacy({
      ...localDirect.defaultConfig as Record<string, unknown>,
      stt: {
        provider: 'happier.voice.google/gemini-stt',
        localNeural: {},
      },
      tts: { provider: 'device', localNeural: {} },
    }, {
      root: {},
      resolveCredential: () => null,
      resolveProviderConfig: (providerId) => providerId === 'happier.voice.google/gemini-stt'
        ? { model: 'gemini-custom', language: 'de' }
        : null,
    }) as Readonly<{
      stt: Readonly<{ googleGemini: unknown; openaiCompat: unknown; providers?: unknown }>;
    }>;
    expect(direct.stt.googleGemini).toEqual({
      model: 'gemini-custom',
      language: 'de',
      apiKey: null,
    });
    expect(direct.stt).not.toHaveProperty('providers');
    expect(direct.stt.openaiCompat).toEqual({ apiKey: null });

    const conversation = localConversation?.projectLegacy({
      ...localConversation.defaultConfig as Record<string, unknown>,
      stt: { provider: 'device', localNeural: {} },
      tts: { provider: 'device', localNeural: {} },
    }, {
      root: {
        welcome: { enabled: true, mode: 'on_first_turn', templateId: 'welcome-1' },
        executionMachine: { mode: 'fixed', machineId: 'machine-1', autoMachineId: null },
      },
      resolveCredential: () => null,
      resolveProviderConfig: () => null,
    }) as Readonly<{ agent: unknown }>;
    expect(conversation.agent).toMatchObject({
      welcome: { enabled: true, mode: 'on_first_turn', templateId: 'welcome-1' },
      machineTargetMode: 'fixed',
      machineTargetId: 'machine-1',
      autoTargetMachineId: null,
    });
  });

  it('does not admit provider-owned analytics semantics through presentation', () => {
    const enabled = createVoiceProviderSettingsCatalog(bundledCatalogInput);
    const disabled = createVoiceProviderSettingsCatalog(emptyBundledCatalogInput);
    const owner = enabled.get(elevenLabsProviderId);
    expect(owner).not.toBeNull();
    const envelope = { schemaVersion: owner!.currentSchemaVersion, config: owner!.defaultConfig };

    expect(enabled.projectAnalytics({ [elevenLabsProviderId]: envelope })).toEqual({});
    expect(disabled.projectAnalytics({ [elevenLabsProviderId]: envelope })).toEqual({});
  });

  it('keeps a version-one secret envelope as migration input instead of admitting it as canonical config', async () => {
    const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
    const legacySecret = { _isSecretValue: true, value: 'xi_legacy' };
    const parsed = voiceSettingsParse({
      providerId: 'realtime_elevenlabs',
      providers: {
        realtime_elevenlabs: {
          schemaVersion: 1,
          config: { billingMode: 'byo', byo: { agentId: 'agent_1', apiKey: legacySecret } },
        },
      },
    });

    expect(parsed.providers[elevenLabsProviderId]).toMatchObject({ schemaVersion: 1 });
    expect(parsed.providers[elevenLabsProviderId].config).toMatchObject({ byo: { apiKey: legacySecret } });
    expect(createVoiceProviderSettingsCatalog(bundledCatalogInput)
      .get(elevenLabsProviderId)?.parseConfig(parsed.providers[elevenLabsProviderId].config)).toBeNull();
  });

  it('preserves a pre-envelope adapter secret only as a version-one migration input', async () => {
    const { voiceSettingsParse } = await import('@/sync/domains/settings/voiceSettings');
    const legacySecret = { _isSecretValue: true, value: 'xi_adapter_legacy' };
    const parsed = voiceSettingsParse({
      providerId: 'realtime_elevenlabs',
      adapters: {
        realtime_elevenlabs: {
          billingMode: 'byo',
          byo: { agentId: 'agent_1', apiKey: legacySecret },
        },
      },
    });

    expect(parsed.providers[elevenLabsProviderId]).toMatchObject({
      schemaVersion: 1,
      config: { byo: { apiKey: legacySecret } },
    });
  });
});
