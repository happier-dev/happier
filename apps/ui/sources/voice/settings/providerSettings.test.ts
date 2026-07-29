import { describe, expect, it } from 'vitest';

import { getBundledVoiceUiEntry } from '@/voice/registry/internalContributions';
import { BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES } from '@/voice/registry/generatedBundledVoiceEntries';
import { createVoiceProviderSettingsCatalog } from './providerSettings';

describe('voice provider settings catalog', () => {
  it('uses public bundled settings for current parsing while retaining only legacy migration behavior', () => {
    const catalog = createVoiceProviderSettingsCatalog({
      bundledEntries: [{
        providerId: 'public_settings_fixture',
        declaration: {
          id: 'public-settings-fixture',
          title: 'Public settings fixture',
          kind: 'conversation',
          roles: ['realtime_conversation'],
          platforms: ['web'],
          capabilities: {
            readiness: { requirements: [] },
            turn: { cancelResponse: false, bargeIn: false },
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
        internal: {
          legacySettingsMigration: {
            defaultLegacyConfig: { legacy: true },
            legacyDefaultSelection: true,
            migrateLegacy: () => ({ config: { mode: 'default', billingMode: 'byo' }, root: {} }),
            projectLegacy: () => null,
            mergeLegacy: () => null,
          },
        },
      }],
    });
    const owner = catalog.get('public_settings_fixture')!;

    expect(owner.defaultConfig).toEqual({ mode: 'default', billingMode: 'hosted' });
    expect(owner.parseConfig({ billingMode: 'byo' })).toBeNull();
    expect(owner.parseConfig({ mode: 'default', billingMode: 'byo', extra: true })).toBeNull();
    expect(owner.parseConfig({ mode: 'default', billingMode: 'byo' })).toEqual({
      mode: 'default',
      billingMode: 'byo',
    });
    expect(owner.migrateLegacy({ legacy: true })).toEqual({
      config: { mode: 'default', billingMode: 'byo' },
      root: {},
    });
  });

  it('removes bundled settings behavior when disabled and restores it without retaining stale state', () => {
    const enabled = createVoiceProviderSettingsCatalog({ bundledEntries: BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES });
    const disabled = createVoiceProviderSettingsCatalog({ bundledEntries: [] });
    const reEnabled = createVoiceProviderSettingsCatalog({ bundledEntries: BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES });

    expect(enabled.get('realtime_elevenlabs')?.defaultConfig).toMatchObject({ billingMode: 'happier' });
    expect(disabled.get('realtime_elevenlabs')).toBeNull();
    expect(disabled.defaultEnvelopes()).not.toHaveProperty('realtime_elevenlabs');
    expect(reEnabled.get('realtime_elevenlabs')?.defaultConfig).toEqual(
      enabled.get('realtime_elevenlabs')?.defaultConfig,
    );
    expect(reEnabled.get('realtime_elevenlabs')).not.toBe(enabled.get('realtime_elevenlabs'));
  });

  it('keeps built-in settings owners available independently of bundled packages', () => {
    const disabled = createVoiceProviderSettingsCatalog({ bundledEntries: [] });
    expect(disabled.get('local_direct')).not.toBeNull();
    expect(disabled.get('local_conversation')).not.toBeNull();
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
    const catalog = createVoiceProviderSettingsCatalog({ bundledEntries: BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES });
    const owner = catalog.get('realtime_codex');
    const bundledEntry = getBundledVoiceUiEntry('realtime_codex');
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
      && 'providerSettings' in bundledEntry.internal
      ? bundledEntry.internal.providerSettings
      : undefined).toBeUndefined();
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
    const catalog = createVoiceProviderSettingsCatalog({ bundledEntries: BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES });
    const owner = catalog.get('realtime_codex');

    expect(owner?.parseConfig({
      globalConnectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': selectedBinding,
        },
      },
    })).toBeNull();
  });

  it('projects current local settings into the pinned remote-dev adapter shape', () => {
    const catalog = createVoiceProviderSettingsCatalog({ bundledEntries: [] });
    const credential = { _isSecretValue: true as const, encryptedValue: { t: 'enc-v1' as const, c: 'ciphertext' } };
    const localDirect = catalog.get('local_direct');
    const localConversation = catalog.get('local_conversation');

    const direct = localDirect?.projectLegacy({
      ...localDirect.defaultConfig as Record<string, unknown>,
      stt: {
        provider: 'google_gemini',
        openaiCompat: { baseUrl: null, model: 'whisper-1' },
        localNeural: {},
        providers: { google_gemini: { schemaVersion: 2, config: { model: 'gemini-custom', language: 'de' } } },
      },
    }, {
      root: {},
      resolveCredential: (providerId, slotId) => providerId === 'google_gemini' && slotId === 'api_key'
        ? credential
        : null,
    }) as Readonly<{
      stt: Readonly<{ googleGemini: unknown; providers?: unknown }>;
    }>;
    expect(direct.stt.googleGemini).toEqual({
      model: 'gemini-custom',
      language: 'de',
      apiKey: credential,
    });
    expect(direct.stt).not.toHaveProperty('providers');

    const conversation = localConversation?.projectLegacy(localConversation.defaultConfig, {
      root: {
        welcome: { enabled: true, mode: 'on_first_turn', templateId: 'welcome-1' },
        executionMachine: { mode: 'fixed', machineId: 'machine-1', autoMachineId: null },
      },
      resolveCredential: () => null,
    }) as Readonly<{ agent: unknown }>;
    expect(conversation.agent).toMatchObject({
      welcome: { enabled: true, mode: 'on_first_turn', templateId: 'welcome-1' },
      machineTargetMode: 'fixed',
      machineTargetId: 'machine-1',
      autoTargetMachineId: null,
    });
  });

  it('projects provider analytics only while the owning bundled contribution is present', () => {
    const enabled = createVoiceProviderSettingsCatalog({ bundledEntries: BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES });
    const disabled = createVoiceProviderSettingsCatalog({ bundledEntries: [] });
    const owner = enabled.get('realtime_elevenlabs');
    expect(owner).not.toBeNull();
    const envelope = { schemaVersion: owner!.currentSchemaVersion, config: owner!.defaultConfig };

    expect(enabled.projectAnalytics({ realtime_elevenlabs: envelope })).toHaveProperty('realtimeElevenLabsBillingMode');
    expect(disabled.projectAnalytics({ realtime_elevenlabs: envelope })).toEqual({});
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

    expect(parsed.providers.realtime_elevenlabs).toMatchObject({ schemaVersion: 1 });
    expect(parsed.providers.realtime_elevenlabs.config).toMatchObject({ byo: { apiKey: legacySecret } });
    expect(createVoiceProviderSettingsCatalog({ bundledEntries: BUNDLED_FIRST_PARTY_VOICE_UI_ENTRIES })
      .get('realtime_elevenlabs')?.parseConfig(parsed.providers.realtime_elevenlabs.config)).toBeNull();
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

    expect(parsed.providers.realtime_elevenlabs).toMatchObject({
      schemaVersion: 1,
      config: { byo: { apiKey: legacySecret } },
    });
  });
});
