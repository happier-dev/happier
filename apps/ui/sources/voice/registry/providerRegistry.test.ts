import { describe, expect, it } from 'vitest';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol';

import {
  createVoiceProviderRegistry,
  projectVoiceProviderCredentialReadiness,
  projectVoiceProviderSettings,
  type VoiceUiRuntimeContribution,
} from './providerRegistry';
import { createDefaultVoiceProviderRegistry } from './defaultRegistry';
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

function bundledSpeechContribution(
  pluginId: string,
  localId: string,
 ) {
  const providerId = `${pluginId}/${localId}`;
  const declaration = VoiceProviderContributionSchema.parse({
    id: localId,
    title: localId,
    kind: 'speech',
    roles: ['dictation_stt'],
    platforms: ['web'],
    settings: {
      schemaVersion: 2,
      fields: [{
        id: 'model',
        title: 'Model',
        schema: { type: 'string', minLength: 1, maxLength: 128 },
        default: 'fixture-model',
        presentation: { control: 'text' },
      }],
    },
  });
  if (declaration.kind !== 'speech') throw new Error('expected speech declaration');
  return {
    contribution: {
      pluginId,
      providerId,
      declaration,
    },
    presentation: {
      providerId,
      settingsSectionId: `voice.fixture.${localId}`,
      createSettingsSpec: () => null,
    },
  };
}

describe('voice provider registry', () => {
  it('composes built-in and bundled entries in deterministic provider-id order', () => {
    const middle = bundledSpeechContribution('happier.voice.middle', 'middle');
    const registry = createVoiceProviderRegistry({
      builtIn: [contribution('zeta'), contribution('alpha')],
      bundledContributions: [middle.contribution],
      bundledPresentations: [middle.presentation],
    });

    expect(registry.list().map((entry) => entry.providerId)).toEqual([
      'alpha',
      'happier.voice.middle/middle',
      'zeta',
    ]);
    expect(registry.get(' happier.voice.middle/middle ')?.source).toEqual({
      kind: 'bundled',
      pluginId: 'happier.voice.middle',
    });
    expect(registry.get('happier.voice.middle/middle')?.supportedPlatforms).toEqual(['web']);
    expect(Object.isFrozen(registry.get('happier.voice.middle/middle')?.roles)).toBe(true);
  });

  it('fails closed on duplicate provider ids instead of allowing last-writer wins', () => {
    const collision = bundledSpeechContribution('happier.voice.other', 'collision');
    expect(() => createVoiceProviderRegistry({
      bundledContributions: [collision.contribution, collision.contribution],
      bundledPresentations: [collision.presentation],
    })).toThrowError(/duplicate_voice_provider_id/u);
  });

  it('removes disabled bundled-package contributions without removing built-ins', () => {
    const enabled = bundledSpeechContribution('happier.voice.enabled', 'enabled-cloud');
    const disabled = bundledSpeechContribution('happier.voice.disabled', 'disabled-cloud');
    const registry = createVoiceProviderRegistry({
      builtIn: [contribution('device_stt')],
      bundledContributions: [enabled.contribution, disabled.contribution],
      bundledPresentations: [enabled.presentation, disabled.presentation],
      enabledPluginIds: new Set(['happier.voice.enabled']),
    });

    expect(registry.list().map((entry) => entry.providerId)).toEqual([
      'device_stt',
      'happier.voice.enabled/enabled-cloud',
    ]);
    expect(registry.get('happier.voice.disabled/disabled-cloud')).toBeNull();
  });

  it('rejects incomplete generated descriptors rather than guessing requirements from an id', () => {
    expect(() => createVoiceProviderRegistry({
      bundledContributions: [{
        // @ts-expect-error Deliberately malformed input proves the runtime parser fails closed.
        kind: 'voice.conversation-provider.v1',
        pluginId: 'happier.voice.fixture',
        providerId: 'looks_like_a_known_provider',
      }],
    })).toThrow();
  });

  it('fails declaration-owned settings projection closed on malformed current config', () => {
    const registry = createDefaultVoiceProviderRegistry();
    const openAi = registry.get('happier.voice.openai/realtime-openai')!;

    expect(projectVoiceProviderSettings(openAi, {
      schemaVersion: 1,
      config: { model: 42 },
    })).toEqual({
      status: 'invalid',
      modeId: null,
    });
  });

  it('uses a bundled public settings declaration as the current projection owner', () => {
    const registry = createVoiceProviderRegistry({
      bundledContributions: [{
        pluginId: 'happier.voice.public-settings-fixture',
        providerId: 'happier.voice.public-settings-fixture/public-settings-fixture',
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
            }, {
              id: 'agentId',
              title: 'Agent ID',
              schema: { type: 'string', maxLength: 128 },
              default: '',
              presentation: { control: 'text' },
            }],
            readiness: [{
              kind: 'setting_nonempty',
              settingId: 'agentId',
              when: { settingId: 'billingMode', equals: 'byo' },
            }],
          },
          client: {
            artifactId: 'client',
            modulePath: './voiceRuntime',
            exportName: 'activate',
          },
        },
      }],
      bundledPresentations: [{
        providerId: 'happier.voice.public-settings-fixture/public-settings-fixture',
        settingsSectionId: 'voice.fixture.public-settings',
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
        createSettingsSection: () => ({ kind: 'voice.internal.realtime-settings.v1' }),
      }],
    });
    const entry = registry.get(
      'happier.voice.public-settings-fixture/public-settings-fixture',
    )!;

    expect(projectVoiceProviderSettings(entry, {
      schemaVersion: 2,
      config: { billingMode: 'byo' },
    })).toEqual({ status: 'invalid', modeId: null });
    expect(projectVoiceProviderSettings(entry, {
      schemaVersion: 2,
      config: { billingMode: 'byo', extra: true },
    })).toEqual({ status: 'invalid', modeId: null });
    expect(projectVoiceProviderSettings(entry, {
      schemaVersion: 2,
      config: { billingMode: 'byo', agentId: '' },
    })).toEqual({ status: 'missing_required_setting', modeId: 'byo' });
  });

  it('projects only the canonical effective source into bundled BYO provider readiness', () => {
    const entry = {
      kind: 'voice.conversation-provider.v1' as const,
      declaration: {
        kind: 'conversation' as const,
        credentials: {
          slot: { id: 'api_key', purpose: 'voice.client-auth', title: 'Credential' },
          requirement: { kind: 'always' as const },
          sources: [
            { kind: 'savedSecret' as const, secretKinds: ['apiKey' as const] },
            {
              kind: 'connectedAccount' as const,
              service: { pluginId: 'fixture.accounts', localId: 'work' },
            },
          ],
        },
      },
    } as Parameters<typeof projectVoiceProviderCredentialReadiness>[0];
    const readyContext = {
      sourceSelection: { kind: 'savedSecret' as const, connectedAccountEligibility: 'unusable' as const },
      savedSecret: { status: 'ready' as const },
    };
    const missingContext = {
      sourceSelection: { kind: 'savedSecret' as const, connectedAccountEligibility: 'unusable' as const },
      savedSecret: { status: 'missing' as const },
    };

    expect(projectVoiceProviderCredentialReadiness(
      entry,
      null,
      readyContext,
    )).toEqual({ status: 'ready', detailKey: 'settingsVoice.externalCredentials.ready' });
    expect(projectVoiceProviderCredentialReadiness(
      entry,
      null,
      {
        sourceSelection: { kind: 'connectedAccount', connectedAccountEligibility: 'usable' },
        savedSecret: { status: 'missing' },
      },
    )).toEqual({ status: 'ready', detailKey: 'settingsVoice.externalCredentials.ready' });
    expect(projectVoiceProviderCredentialReadiness(
      entry,
      null,
      {
        sourceSelection: { kind: 'connectedAccount', connectedAccountEligibility: 'unknown' },
        savedSecret: { status: 'missing' },
      },
    )).toEqual({ status: 'unknown', detailKey: 'voice.readiness.credential_unknown' });
    expect(projectVoiceProviderCredentialReadiness(
      entry,
      null,
      {
        sourceSelection: { kind: 'connectedAccount', connectedAccountEligibility: 'unusable' },
        savedSecret: { status: 'missing' },
      },
    )).toEqual({ status: 'missing', detailKey: 'settingsVoice.externalCredentials.missing' });
    expect(projectVoiceProviderCredentialReadiness(
      entry,
      null,
      missingContext,
    )).toEqual({ status: 'missing', detailKey: 'settingsVoice.externalCredentials.missing' });
    expect(projectVoiceProviderCredentialReadiness(
      entry,
      null,
      { sourceSelection: null, savedSecret: { status: 'ready' } },
    )).toEqual({ status: 'unknown', detailKey: 'voice.readiness.credential_unknown' });
  });

  it('consumes built-in substrate and generated first-party package entries', () => {
    const registry = createDefaultVoiceProviderRegistry();
    expect(registry.get('device')).toMatchObject({ source: { kind: 'built_in' }, role: 'both' });
    const elevenLabs = registry.get('happier.voice.elevenlabs/realtime-elevenlabs');
    expect(elevenLabs).toMatchObject({
      source: { kind: 'bundled', pluginId: 'happier.voice.elevenlabs' },
      roles: expect.arrayContaining(['realtime_conversation', 'turn_control']),
      requirementsByMode: {
        happier: [],
        byo: ['credential'],
      },
    });
    const elevenLabsDefaults = elevenLabs?.providerSettings?.defaultConfig as Readonly<
      Record<string, unknown>
    >;
    expect(elevenLabs?.projectSettings?.({
      schemaVersion: 2,
      config: {
        ...elevenLabsDefaults,
        billingMode: 'byo',
      },
    })).toMatchObject({ status: 'missing_required_setting', modeId: 'byo' });
    expect(elevenLabs?.projectSettings?.({
      schemaVersion: 2,
      config: {
        ...elevenLabsDefaults,
        billingMode: 'byo',
        agentId: 'agent_1',
      },
    })).toMatchObject({ status: 'ready', modeId: 'byo' });
    expect(elevenLabs?.projectSettings?.({
      schemaVersion: 2,
      config: {
        ...elevenLabsDefaults,
        billingMode: 'happier',
      },
    })).toMatchObject({ status: 'ready', modeId: 'happier' });
    expect(elevenLabs?.projectSettings?.({
      schemaVersion: 2,
      config: {
        ...elevenLabsDefaults,
        billingMode: 'unsupported',
      },
    })).toMatchObject({ status: 'invalid', modeId: null });
    expect(registry.get('happier.agent.codex/realtime-codex')?.projectSettings?.({
      schemaVersion: 2,
      config: {
        globalConnectedServices: null,
      },
    })).toMatchObject({
      status: 'missing_required_setting',
      modeId: 'experimental',
    });
    expect(registry.get('happier.voice.google/gemini-stt')).toMatchObject({
      source: { kind: 'bundled', pluginId: 'happier.voice.google' },
      roles: ['dictation_stt', 'conversation_stt'],
    });

    const disabled = createDefaultVoiceProviderRegistry({
      enabledPluginIds: new Set(['happier.voice.elevenlabs']),
    });
    expect(disabled.get('happier.voice.google/gemini-stt')).toBeNull();
    expect(disabled.get('device')).not.toBeNull();
  });
});
