import { describe, expect, it } from 'vitest';

import {
  createVoiceProviderRegistry,
  projectVoiceProviderCredentialReadiness,
  projectVoiceProviderSettings,
  type VoiceUiRuntimeContribution,
} from './providerRegistry';
import { createDefaultVoiceProviderRegistry } from './defaultRegistry';
import {
  BUNDLED_VOICE_UI_ENTRIES as SOURCE_ELEVENLABS_VOICE_UI_ENTRIES,
} from '../../../../../packages/plugins/elevenlabs/src/ui/voice/index';
import {
  ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
} from '../../../../../packages/plugins/elevenlabs/src/protocol/voice/index';
import {
  OPENAI_REALTIME_DEFAULT_SETTINGS,
} from '../../../../../packages/plugins/openai/src/protocol/voice/settings';
import {
  XAI_REALTIME_DEFAULT_SETTINGS,
} from '../../../../../packages/plugins/xai/src/protocol/voice/settings';

function contribution(
  providerId: string,
  overrides: Partial<VoiceUiRuntimeContribution> = {},
): VoiceUiRuntimeContribution {
  return {
    kind: 'voice.speech-engine.v1',
    pluginId: 'happier.voice.fixture',
    providerId,
    role: 'stt',
    settingsSectionId: `voice.fixture.${providerId}`,
    roles: ['dictation_stt', 'conversation_stt'],
    requirements: [],
    ...overrides,
  } as VoiceUiRuntimeContribution;
}

describe('voice provider registry', () => {
  it('composes built-in and bundled entries in deterministic provider-id order', () => {
    const registry = createVoiceProviderRegistry({
      builtIn: [contribution('zeta'), contribution('alpha')],
      bundled: [contribution('middle', { pluginId: 'happier.voice.middle' })],
    });

    expect(registry.list().map((entry) => entry.providerId)).toEqual(['alpha', 'middle', 'zeta']);
    expect(registry.get(' middle ')?.source).toEqual({ kind: 'bundled', pluginId: 'happier.voice.middle' });
    expect(Object.isFrozen(registry.get('middle')?.roles)).toBe(true);
  });

  it('fails closed on duplicate provider ids instead of allowing last-writer wins', () => {
    expect(() => createVoiceProviderRegistry({
      builtIn: [contribution('collision')],
      bundled: [contribution('collision', { pluginId: 'happier.voice.other' })],
    })).toThrowError(/duplicate_voice_provider_id/u);
  });

  it('removes disabled bundled-package contributions without removing built-ins', () => {
    const registry = createVoiceProviderRegistry({
      builtIn: [contribution('device_stt')],
      bundled: [
        contribution('enabled_cloud', { pluginId: 'happier.voice.enabled' }),
        contribution('disabled_cloud', { pluginId: 'happier.voice.disabled' }),
      ],
      enabledPluginIds: new Set(['happier.voice.enabled']),
    });

    expect(registry.list().map((entry) => entry.providerId)).toEqual(['device_stt', 'enabled_cloud']);
    expect(registry.get('disabled_cloud')).toBeNull();
  });

  it('rejects incomplete generated descriptors rather than guessing requirements from an id', () => {
    expect(() => createVoiceProviderRegistry({
      // @ts-expect-error Deliberately malformed input proves the runtime parser fails closed.
      bundled: [{
        kind: 'voice.conversation-provider.v1',
        pluginId: 'happier.voice.fixture',
        providerId: 'looks_like_a_known_provider',
      }],
    })).toThrowError(/invalid_voice_provider_descriptor/u);
  });

  it('fails settings projection closed when bundled executable code throws or returns malformed facts', () => {
    const throwing = createVoiceProviderRegistry({
      bundled: [contribution('throwing', {
        projectSettings: () => {
          throw new Error('provider bug must not escape the registry boundary');
        },
      })],
    });
    const malformed = createVoiceProviderRegistry({
      bundled: [{
        ...contribution('malformed'),
        // @ts-expect-error Deliberately malformed projector output exercises runtime validation.
        projectSettings: () => ({ status: 'ready', modeId: 42 }),
      }],
    });

    expect(projectVoiceProviderSettings(throwing.get('throwing')!, null)).toEqual({
      status: 'invalid',
      modeId: null,
    });
    expect(projectVoiceProviderSettings(malformed.get('malformed')!, null)).toEqual({
      status: 'invalid',
      modeId: null,
    });
  });

  it('uses a bundled public settings declaration as the current projection owner', () => {
    const registry = createVoiceProviderRegistry({
      bundled: [{
        kind: 'voice.conversation-provider.v1',
        pluginId: 'happier.voice.public-settings-fixture',
        providerId: 'public_settings_fixture',
        settingsSectionId: 'voice.fixture.public-settings',
        roles: ['realtime_conversation'],
        requirements: [],
        supportedPlatforms: ['web'],
        selectionOptions: [
          {
            id: 'hosted',
            modeId: 'hosted',
            order: 10,
            titleKey: 'fixture.hosted',
            subtitleKey: 'fixture.hosted.subtitle',
            configPatch: { billingMode: 'hosted' },
          },
          {
            id: 'byo',
            modeId: 'byo',
            order: 20,
            titleKey: 'fixture.byo',
            subtitleKey: 'fixture.byo.subtitle',
            configPatch: { billingMode: 'byo' },
          },
        ],
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
        projectSettings: () => ({ status: 'ready', modeId: 'private' }),
        internal: {
          createSettingsSection: () => ({
            kind: 'voice.internal.realtime-settings.v1',
            providerId: 'public_settings_fixture',
          }),
        },
      }],
    });
    const entry = registry.get('public_settings_fixture')!;

    expect(projectVoiceProviderSettings(entry, {
      schemaVersion: 2,
      config: { billingMode: 'byo' },
    })).toEqual({ status: 'invalid', modeId: null });
    expect(projectVoiceProviderSettings(entry, {
      schemaVersion: 2,
      config: { mode: 'default', billingMode: 'byo', extra: true },
    })).toEqual({ status: 'invalid', modeId: null });
    expect(projectVoiceProviderSettings(entry, {
      schemaVersion: 2,
      config: { mode: 'default', billingMode: 'byo' },
    })).toEqual({ status: 'ready', modeId: 'byo' });
  });

  it('projects provider-owned credential readiness through the guarded registry boundary', () => {
    const registry = createVoiceProviderRegistry({
      bundled: [{
        kind: 'voice.conversation-provider.v1',
        pluginId: 'happier.voice.fixture',
        providerId: 'credential_ready',
        settingsSectionId: 'voice.fixture.credential_ready',
        roles: ['realtime_conversation'],
        requirements: ['credential'],
        internal: {
          providerSettings: {
            schemaVersion: 1,
            defaultConfig: { authentication: { source: 'saved' } },
            parseConfig: (value: unknown) => value ? {} : null,
          },
          projectCredentialReadiness: (config: unknown, context: Readonly<{
            accountProfile: unknown;
            savedSecret: Readonly<{ status: 'ready' | 'missing' }>;
          }>) => (
            config && context.accountProfile
              ? { status: 'ready', detailKey: 'fixture.ready' }
              : { status: 'missing', detailKey: 'fixture.missing' }
          ),
        },
      }],
    });

    expect(projectVoiceProviderCredentialReadiness(
      registry.get('credential_ready')!,
      { schemaVersion: 1, config: { authentication: { source: 'connected' } } },
      {
        accountProfile: { id: 'account' },
        savedSecret: { status: 'missing' },
      },
    )).toEqual({ status: 'ready', detailKey: 'fixture.ready' });
  });

  it('projects generic SavedSecret presence into bundled BYO provider readiness', () => {
    const registry = createDefaultVoiceProviderRegistry();
    const readyContext = {
      accountProfile: {},
      savedSecret: { status: 'ready' as const },
    };
    const missingContext = {
      accountProfile: {},
      savedSecret: { status: 'missing' as const },
    };

    expect(projectVoiceProviderCredentialReadiness(
      registry.get('realtime_openai')!,
      {
        schemaVersion: 1,
        config: {
          ...OPENAI_REALTIME_DEFAULT_SETTINGS,
          authentication: { source: 'voice_saved_secret' },
        },
      },
      readyContext,
    )).toMatchObject({ status: 'ready' });
    expect(projectVoiceProviderCredentialReadiness(
      registry.get('realtime_openai')!,
      {
        schemaVersion: 1,
        config: {
          ...OPENAI_REALTIME_DEFAULT_SETTINGS,
          authentication: { source: 'connected_service_api_key' },
        },
      },
      readyContext,
    )).toMatchObject({ status: 'unknown' });
    expect(projectVoiceProviderCredentialReadiness(
      registry.get('realtime_grok')!,
      {
        schemaVersion: 1,
        config: XAI_REALTIME_DEFAULT_SETTINGS,
      },
      missingContext,
    )).toMatchObject({ status: 'missing' });
    const sourceElevenLabsRegistry = createVoiceProviderRegistry({
      bundled: SOURCE_ELEVENLABS_VOICE_UI_ENTRIES,
    });
    expect(projectVoiceProviderCredentialReadiness(
      sourceElevenLabsRegistry.get('realtime_elevenlabs')!,
      {
        schemaVersion: 2,
        config: {
          ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
          billingMode: 'byo',
        },
      },
      readyContext,
    )).toMatchObject({ status: 'ready' });
    expect(projectVoiceProviderCredentialReadiness(
      sourceElevenLabsRegistry.get('realtime_elevenlabs')!,
      {
        schemaVersion: 2,
        config: {
          ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
          billingMode: 'happier',
        },
      },
      readyContext,
    )).toMatchObject({ status: 'unknown' });
  });

  it('consumes built-in substrate and generated first-party package entries', () => {
    const registry = createDefaultVoiceProviderRegistry();
    expect(registry.get('device')).toMatchObject({ source: { kind: 'built_in' }, role: 'both' });
    expect(registry.get('realtime_elevenlabs')).toMatchObject({
      source: { kind: 'bundled', pluginId: 'happier.voice.elevenlabs' },
      roles: expect.arrayContaining(['realtime_conversation', 'turn_control']),
      requirementsByMode: {
        happier: ['server_feature'],
        byo: ['credential'],
      },
    });
    expect(registry.get('realtime_elevenlabs')?.projectSettings?.({
      schemaVersion: 2,
      config: {
        ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
        billingMode: 'byo',
      },
    })).toMatchObject({ status: 'ready', modeId: 'byo' });
    expect(registry.get('realtime_elevenlabs')?.projectSettings?.({
      schemaVersion: 2,
      config: {
        ...ELEVENLABS_VOICE_PROVIDER_DEFAULT_SETTINGS,
        billingMode: 'unsupported',
      },
    })).toMatchObject({ status: 'invalid', modeId: null });
    expect(registry.get('google_gemini')).toMatchObject({
      source: { kind: 'bundled', pluginId: 'happier.voice.google' },
      roles: ['dictation_stt', 'conversation_stt'],
    });

    const disabled = createDefaultVoiceProviderRegistry({
      enabledPluginIds: new Set(['happier.voice.elevenlabs']),
    });
    expect(disabled.get('google_gemini')).toBeNull();
    expect(disabled.get('device')).not.toBeNull();
  });
});
