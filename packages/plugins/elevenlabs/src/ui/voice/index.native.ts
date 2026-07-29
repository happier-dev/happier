import { PluginVoiceProviderContributionV1Schema } from '@happier-dev/protocol';

import { PLUGIN_MANIFEST } from '../../manifest.js';
import { createElevenLabsSettingsSection } from './settings.js';
import { ElevenLabsVoiceProviderSettingsSchema } from '../../protocol/voice/index.js';
import { projectElevenLabsSettingsReadiness } from './settingsReadiness.js';

const declaration = PluginVoiceProviderContributionV1Schema.parse(
  PLUGIN_MANIFEST.contributes.voiceProviders[0],
);
if (declaration.kind !== 'conversation') {
  throw new Error('elevenlabs_voice_provider_must_be_conversation');
}

function projectElevenLabsCredentialReadiness(
  providerConfig: unknown,
  context: Readonly<{
    accountProfile: unknown;
    savedSecret: Readonly<{ status: 'ready' | 'missing' }>;
  }>,
) {
  const parsed = ElevenLabsVoiceProviderSettingsSchema.safeParse(providerConfig);
  if (!parsed.success || parsed.data.billingMode !== 'byo') {
    return Object.freeze({
      status: 'unknown' as const,
      detailKey: 'settingsVoice.mode.happierSubtitle',
    });
  }
  return Object.freeze({
    status: context.savedSecret.status,
    detailKey: context.savedSecret.status === 'ready'
      ? 'settingsVoice.externalCredentials.ready'
      : 'settingsVoice.externalCredentials.missing',
  });
}

/**
 * Native resolves only inert public metadata for this web-only provider. It
 * deliberately does not import the web activation or ElevenLabs SDK graph.
 */
export const BUNDLED_VOICE_UI_ENTRIES = Object.freeze([
  Object.freeze({
    kind: 'voice.conversation-provider.v1' as const,
    pluginId: PLUGIN_MANIFEST.id,
    providerId: 'realtime_elevenlabs' as const,
    declaration,
    settingsSectionId: 'voice.provider.realtime_elevenlabs',
    roles: declaration.roles,
    requirements: declaration.capabilities.readiness.requirements,
    requirementsByMode: Object.freeze({
      happier: Object.freeze(['server_feature']),
      byo: Object.freeze(['credential']),
    }),
    supportedPlatforms: declaration.platforms,
    selectionOptions: Object.freeze([
      Object.freeze({
        id: 'happier',
        modeId: 'happier',
        order: 10,
        titleKey: 'settingsVoice.mode.happier',
        subtitleKey: 'settingsVoice.mode.happierSubtitle',
        configPatch: Object.freeze({ billingMode: 'happier' }),
      }),
      Object.freeze({
        id: 'byo',
        modeId: 'byo',
        order: 20,
        titleKey: 'settingsVoice.mode.byo',
        subtitleKey: 'settingsVoice.mode.byoSubtitle',
        configPatch: Object.freeze({ billingMode: 'byo' }),
      }),
    ]),
    internal: Object.freeze({
      createSettingsSection: createElevenLabsSettingsSection,
      projectSettingsReadiness: projectElevenLabsSettingsReadiness,
      projectCredentialReadiness: projectElevenLabsCredentialReadiness,
    }),
  }),
]);
