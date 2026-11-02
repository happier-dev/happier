import { describe, expect, it } from 'vitest';
import { VoiceProviderContributionSchema } from '@happier-dev/protocol';

import {
  createVoiceProviderRegistry,
  projectVoiceProviderCredentialReadiness,
  projectVoiceProviderSettings,
  projectVoiceProviderDeclarationRegistryBase,
  type VoiceUiRuntimeContribution,
  type VoiceProviderRegistryEntry,
} from './providerRegistry';
import { createDefaultVoiceProviderRegistry } from './defaultRegistry';
import { projectVoiceProviderSelectionRows } from './providerSelection';
import { BUILT_IN_VOICE_UI_ENTRIES } from './builtInEntries';
import {
  commitExternalVoiceProviderRegistration,
  removeExternalVoiceProviderRegistration,
  replaceExternalVoiceProviderProjectionAuthority,
} from './externalVoiceProviderRegistrations';
function contribution(
  providerId: string,
): VoiceUiRuntimeContribution {
  return {
    kind: 'voice.speech-engine.v1',
    pluginId: 'happier.voice.fixture',
    providerId,
    role: 'stt',
    settingsSectionId: `voice.fixture.${providerId}`,
    roles: ['dictation_stt', 'conversation_stt'],
    requirements: [],
    supportedPlatforms: ['web', 'ios', 'android'],
  };
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
  it.each([undefined, { key: 'voice.service.description', fallback: 'Talk with this service.' }])(
    'projects optional service descriptions separately from selection options (%j)', (description) => {
    const pluginId = 'fixture.conversation';
    const providerId = `${pluginId}/voice`;
    const declaration = VoiceProviderContributionSchema.parse({
      id: 'voice', title: 'Fixture voice', kind: 'conversation', roles: ['realtime_conversation'], platforms: ['web'],
      ...(description ? { description } : {}),
      capabilities: { turn: { cancelResponse: false, bargeIn: false }, tools: { effectCalls: 'none' } },
      client: { artifactId: 'voice', exportName: 'activate' },
    });
    const registry = createVoiceProviderRegistry({
      bundledContributions: [{ pluginId, providerId, declaration }],
      bundledPresentations: [{ providerId, settingsSectionId: providerId,
        selectionOptions: [{ id: 'default', modeId: 'default', order: 1, titleKey: 'Fixture voice' }] }],
    });
    expect(projectVoiceProviderSelectionRows({ providerId, providers: {} }, registry)[0]?.subtitleKey).toBe('');
    expect(registry.get(providerId)).toMatchObject(description ? { description } : {});
    if (!description) expect(registry.get(providerId)).not.toHaveProperty('description');
  });
  it('reuses immutable bundled descriptors across default registry consumers without retaining config validation results', () => {
    const registries = Array.from({ length: 40 }, () => createDefaultVoiceProviderRegistry());
    const providerId = 'happier.voice.elevenlabs/realtime-elevenlabs';
    const first = registries[0]!.get(providerId)!;
    expect(Object.isFrozen(first)).toBe(true);
    expect(Reflect.set(first, 'settingsSectionId', 'changed-section')).toBe(false);
    for (const registry of registries.slice(1)) expect(registry.get(providerId)).toBe(first);
    const defaults = first.providerSettings!.defaultConfig;
    expect(Object.isFrozen(defaults)).toBe(true);
    expect(Object.isFrozen(defaults.byo)).toBe(true);
    if (defaults.byo && typeof defaults.byo === 'object') {
      expect(Reflect.set(defaults.byo, 'apiKey', 'changed-key')).toBe(false);
    }
    expect(first.providerSettings!.parseConfig(defaults)).not.toBeNull();
    expect(first.providerSettings!.parseConfig({ ...defaults, billingMode: 'byo' }))
      .toMatchObject({ billingMode: 'byo' });
    expect(first.providerSettings!.parseConfig({ ...defaults, billingMode: 'invalid-mode' })).toBeNull();
    expect(first.providerSettings!.parseConfig(defaults)).not.toBeNull();
    const disabled = createDefaultVoiceProviderRegistry({ enabledPluginIds: new Set() });
    expect(disabled.get(providerId)).toBeNull();
    expect(disabled.get('device')).toBe(registries[0]!.get('device'));
  });
  it('retains built-in service art at the same public mark owner', () => {
    const registry = createVoiceProviderRegistry({ builtIn: BUILT_IN_VOICE_UI_ENTRIES });
    expect(registry.get('local_conversation')?.mark).toEqual({ kind: 'icon', name: 'desktop' });
  });
  it('projects an external service mark at the same declaration owner as bundled identity', () => {
    const declaration = VoiceProviderContributionSchema.parse({
      id: 'conversation', title: 'Installed service', kind: 'conversation',
      mark: { kind: 'icon', name: 'waveform' }, roles: ['realtime_conversation'], platforms: ['web'],
      capabilities: { turn: { cancelResponse: true, bargeIn: true }, tools: { effectCalls: 'none' } },
      client: { artifactId: 'voice', exportName: 'activate' },
    });
    expect(projectVoiceProviderDeclarationRegistryBase({ declaration, providerSettings: null }).mark)
      .toEqual({ kind: 'icon', name: 'waveform' });
    const openai = createDefaultVoiceProviderRegistry().get('happier.voice.openai/realtime-openai');
    expect(openai?.mark).toEqual({ kind: 'connected_service', serviceId: 'openai' });
  });
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

  it('rejects a built-in descriptor that omits its exact platform applicability', () => {
    const missingPlatforms = contribution('missing-platforms');
    const { supportedPlatforms: _supportedPlatforms, ...raw } = missingPlatforms;

    expect(() => createVoiceProviderRegistry({
      builtIn: [raw as VoiceUiRuntimeContribution],
    })).toThrowError(/invalid_voice_provider_descriptor/u);
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
    const declaration = VoiceProviderContributionSchema.parse({
      id: 'credential-readiness', title: 'Credential readiness', kind: 'conversation',
      roles: ['realtime_conversation'], platforms: ['web'],
      capabilities: { turn: { cancelResponse: false, bargeIn: false } },
      client: { artifactId: 'voice-runtime', exportName: 'activate' },
      credentials: {
          slot: { id: 'api_key', purpose: 'voice.client-auth', title: 'Credential' },
          requirement: { kind: 'always' as const },
          sources: [
            { kind: 'savedSecret' as const, secretKinds: ['apiKey' as const], rawGrants: [{
              realm: 'web', phase: 'connection', request: { kind: 'httpHeaders',
                origin: 'https://voice.example.test', headerNames: ['authorization'] },
            }] },
            {
              kind: 'connectedAccount' as const,
              service: { pluginId: 'fixture.accounts', localId: 'work' },
              rawGrants: [{ realm: 'web', phase: 'connection', request: { kind: 'httpHeaders',
                origin: 'https://voice.example.test', headerNames: ['authorization'] },
              }],
            },
          ],
      },
    });
    const providerId = 'fixture.accounts/credential-readiness';
    const entry = createVoiceProviderRegistry({
      bundledContributions: [{ pluginId: 'fixture.accounts', providerId, declaration }],
      bundledPresentations: [{ providerId, settingsSectionId: providerId }],
    }).get(providerId);
    if (!entry) throw new Error('Credential readiness declaration was not projected');
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

  it('uses one projection-authoritative unique identity for get and list', () => {
    const providerId = 'happier.voice.fixture/installed-stt';
    const registry = createDefaultVoiceProviderRegistry();
    const fallback = createVoiceProviderRegistry({ builtIn: [contribution(providerId)] }).get(providerId);
    if (!fallback) throw new Error('expected external fixture descriptor');
    const token = Object.freeze({});
    try {
      replaceExternalVoiceProviderProjectionAuthority(null, token, new Map([[providerId, 'google-occurrence-7']]));
      commitExternalVoiceProviderRegistration(Object.freeze({
        token,
        pluginId: fallback.pluginId,
        localId: 'gemini-stt',
        providerId,
        occurrenceId: 'google-occurrence-6',
        descriptor: Object.freeze({
          ...fallback,
          settingsSectionId: 'voice.projected.stale-google',
        }),
        adapter: null,
      }));
      expect(registry.get(providerId)).toBeNull();

      commitExternalVoiceProviderRegistration(Object.freeze({
        token,
        pluginId: fallback.pluginId,
        localId: 'gemini-stt',
        providerId,
        occurrenceId: 'google-occurrence-7',
        descriptor: Object.freeze({
          ...fallback,
          settingsSectionId: 'voice.projected.current-google',
          source: Object.freeze({
            kind: 'external' as const,
            pluginId: fallback.pluginId,
            localId: 'gemini-stt',
          }),
        }),
        adapter: null,
      }));

      expect(registry.get(providerId)).toMatchObject({
        settingsSectionId: 'voice.projected.current-google',
        source: { kind: 'external' },
      });
      expect(registry.list().filter((entry) => entry.providerId === providerId)).toHaveLength(1);
      expect(registry.list().find((entry) => entry.providerId === providerId))
        .toBe(registry.get(providerId));
    } finally {
      removeExternalVoiceProviderRegistration(token);
    }

    expect(registry.get(providerId)).toBeNull();
  });

  it('keeps each first-party service and its declared gallery modes identical before and after installed admission', () => {
    const registry = createDefaultVoiceProviderRegistry();
    const services = registry.list().filter((entry): entry is Exclude<VoiceProviderRegistryEntry, { kind: 'voice.turn-support.v1' }> => entry.kind !== 'voice.turn-support.v1' && entry.source.kind === 'bundled');
    const settings = { providerId: 'happier.voice.openai/realtime-openai', providers: {} };
    const discoveryRows = projectVoiceProviderSelectionRows(settings, registry);
    expect(discoveryRows).toHaveLength(6);
    const token = Object.freeze({});
    try {
      for (const service of services) {
        if (!service.declaration || !service.providerSettings) throw new Error('expected declared first-party settings');
        const selectionOptions = service.kind === 'voice.conversation-provider.v1'
          ? [{ id: 'default', modeId: 'default', order: 10_000,
              titleKey: service.declaration.id, subtitleKey: '', configPatch: service.providerSettings.defaultConfig }]
          : [];
        // The real installed declaration projector creates this generic descriptor.
        commitExternalVoiceProviderRegistration({
          token, pluginId: service.pluginId, localId: service.declaration.id,
          providerId: service.providerId, occurrenceId: `${service.providerId}-current`, adapter: null,
          descriptor: Object.freeze({
            ...service,
            ...projectVoiceProviderDeclarationRegistryBase({
              declaration: service.declaration, providerSettings: service.providerSettings, selectionOptions,
            }),
            settingsSectionId: service.providerId,
            presentation: undefined,
            source: { kind: 'external' as const, pluginId: service.pluginId, localId: service.declaration.id },
          }),
        });
      }
      const installedRows = projectVoiceProviderSelectionRows(settings, registry);
      replaceExternalVoiceProviderProjectionAuthority(null, token, new Map(
        services.map((service) => [service.providerId, `${service.providerId}-current`]),
      ));
      const admittedRows = projectVoiceProviderSelectionRows(settings, registry);
      expect(installedRows).toEqual(discoveryRows);
      expect(admittedRows).toEqual(discoveryRows);
      for (const service of services) {
        expect(registry.get(service.providerId)).toBe(service);
        expect(registry.list().filter((entry) => entry.providerId === service.providerId)).toEqual([service]);
      }
      const disabled = createDefaultVoiceProviderRegistry({ enabledPluginIds: new Set() });
      expect(disabled.list().every((entry) => entry.source.kind === 'built_in')).toBe(true);
      const service = services[0]!;
      commitExternalVoiceProviderRegistration({
        token, pluginId: service.pluginId, localId: service.declaration!.id,
        providerId: service.providerId, occurrenceId: `${service.providerId}-stale`, adapter: null,
        descriptor: service,
      });
      expect(registry.get(service.providerId)).toBeNull();
    } finally {
      removeExternalVoiceProviderRegistration(token);
    }
    expect(projectVoiceProviderSelectionRows(settings, registry)).toEqual(discoveryRows);
  });

  it('does not re-admit disabled generated providers while projection authority is available', () => {
    const registry = createDefaultVoiceProviderRegistry();
    const token = Object.freeze({});
    const admittedProviderId = 'happier.voice.elevenlabs/realtime-elevenlabs';
    try {
      replaceExternalVoiceProviderProjectionAuthority(
        null,
        token,
        new Map([[admittedProviderId, 'elevenlabs-occurrence-8']]),
      );

      expect(registry.get('happier.voice.google/gemini-stt')).toBeNull();
      // A complete projection is authority, not activation success. Until its
      // runtime registration commits, the provider is truthfully absent rather
      // than resurrected from generated fallback bytes.
      expect(registry.get(admittedProviderId)).toBeNull();
      expect(registry.get('device')).not.toBeNull();
      expect(registry.list().some((entry) => entry.source.kind === 'bundled')).toBe(false);

      commitExternalVoiceProviderRegistration(Object.freeze({
        token,
        pluginId: 'happier.voice.elevenlabs',
        localId: 'realtime-elevenlabs',
        providerId: admittedProviderId,
        occurrenceId: 'elevenlabs-occurrence-8',
        // Bundled conversations intentionally reuse their generated descriptor;
        // the live registration supplies enablement/occurrence authority.
        descriptor: null,
        adapter: null,
      }));
      expect(registry.get(admittedProviderId)?.source).toEqual({
        kind: 'bundled',
        pluginId: 'happier.voice.elevenlabs',
      });
      expect(registry.list().filter((entry) => entry.providerId === admittedProviderId)).toHaveLength(1);
    } finally {
      removeExternalVoiceProviderRegistration(token);
    }
  });

  it('keeps an admitted conversation selectable before its executable is demanded', () => {
    const registry = createDefaultVoiceProviderRegistry();
    const providerId = 'happier.voice.openai/realtime-openai';
    const descriptor = registry.get(providerId);
    if (!descriptor) throw new Error('missing bundled conversation descriptor');
    const token = Object.freeze({});
    try {
      replaceExternalVoiceProviderProjectionAuthority(null, token, new Map([[providerId, 'cold-openai']]),
        [], [descriptor]);
      expect(registry.get(providerId)).toBe(descriptor);
      expect(registry.get('happier.voice.xai/realtime-xai')).toBeNull();
      expect(registry.list().filter(entry => entry.kind === 'voice.conversation-provider.v1'
        && entry.source.kind !== 'built_in')).toEqual([descriptor]);
    } finally {
      removeExternalVoiceProviderRegistration(token);
    }
  });
});
