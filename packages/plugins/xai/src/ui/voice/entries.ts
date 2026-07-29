import { XAI_REALTIME_DEFAULT_SETTINGS, XaiRealtimeSettingsV1Schema } from '../../protocol/voice/settings.js';
import type { BundledVoiceUiEntry } from '@happier-dev/bundled-voice-runtime-contract';
import { PluginVoiceProviderContributionV1Schema } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { createXaiRealtimeVoiceUiClient } from './client.js';
import { createXaiRealtimeSettingsSection } from './settingsSection.js';

const providerSettings = Object.freeze({
  schemaVersion: 1 as const,
  defaultConfig: XAI_REALTIME_DEFAULT_SETTINGS,
  defaultLegacyConfig: XAI_REALTIME_DEFAULT_SETTINGS,
  legacyDefaultSelection: false,
  parseConfig(value: unknown) {
    const parsed = XaiRealtimeSettingsV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  migrateLegacy(value: unknown) {
    const parsed = XaiRealtimeSettingsV1Schema.safeParse(value);
    return parsed.success ? Object.freeze({ config: parsed.data, root: Object.freeze({}) }) : null;
  },
  projectLegacy() {
    return null;
  },
  mergeLegacy(_currentValue: unknown, migratedValue: unknown) {
    const parsed = XaiRealtimeSettingsV1Schema.safeParse(migratedValue);
    return parsed.success ? parsed.data : null;
  },
  projectAnalytics(value: unknown) {
    const parsed = XaiRealtimeSettingsV1Schema.safeParse(value);
    return parsed.success ? Object.freeze({
      realtimeGrokModelKind: parsed.data.model.kind,
      realtimeGrokReasoningEffort: parsed.data.reasoningEffort,
      realtimeGrokResumptionEnabled: parsed.data.resumptionEnabled,
    }) : Object.freeze({});
  },
});

function projectXaiCredentialReadiness(
  _providerConfig: unknown,
  context: Readonly<{
    accountProfile: unknown;
    savedSecret: Readonly<{ status: 'ready' | 'missing' }>;
  }>,
) {
  return Object.freeze({
    status: context.savedSecret.status,
    detailKey: context.savedSecret.status === 'ready'
      ? 'settingsVoice.externalCredentials.ready'
      : 'settingsVoice.externalCredentials.missing',
  });
}

const parsedXaiVoiceProviderDeclaration = PluginVoiceProviderContributionV1Schema.parse(
  PLUGIN_MANIFEST.contributes.voiceProviders[0],
);
if (parsedXaiVoiceProviderDeclaration.kind !== 'conversation') {
  throw new Error('xai_realtime_voice_conversation_declaration_required');
}
const xaiVoiceProviderDeclaration = parsedXaiVoiceProviderDeclaration;

export const BUNDLED_VOICE_UI_ENTRIES = Object.freeze([
  Object.freeze({
    kind: 'voice.conversation-provider.v1' as const,
    pluginId: 'happier.voice.xai',
    providerId: 'realtime_grok',
    declaration: xaiVoiceProviderDeclaration,
    settingsSectionId: 'voice.provider.realtime_grok',
    roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
    requirements: ['credential'],
    supportedPlatforms: ['web'],
    selectionOptions: [{
      id: 'byo', modeId: 'byo', order: 22,
      titleKey: 'settingsVoice.mode.grokRealtime',
      subtitleKey: 'settingsVoice.mode.grokRealtimeSubtitle',
    }],
    projectSettings(envelope: Readonly<{ schemaVersion: number; config: unknown }> | null) {
      if (!envelope || envelope.schemaVersion < 1) return { status: 'needs_migration' as const, modeId: null };
      if (envelope.schemaVersion > 1) return { status: 'unsupported_version' as const, modeId: null };
      return XaiRealtimeSettingsV1Schema.safeParse(envelope.config).success
        ? { status: 'ready' as const, modeId: 'byo' }
        : { status: 'invalid' as const, modeId: null };
    },
    internal: Object.freeze({
      providerSettings,
      createSettingsSection: createXaiRealtimeSettingsSection,
      createAccountOperationClient: createXaiRealtimeVoiceUiClient,
      projectCredentialReadiness: projectXaiCredentialReadiness,
      resolveSurfaceCapabilities(providerConfig: unknown) {
        if (!XaiRealtimeSettingsV1Schema.safeParse(providerConfig).success) return null;
        const turn = xaiVoiceProviderDeclaration.capabilities.turn;
        return Object.freeze({
          allowsGlobalStart: true,
          controlSessionScope: 'global' as const,
          requiresVoiceAgentFeature: false,
          bargeInEnabled: turn.bargeIn,
          cancelResponse: turn.cancelResponse ? 'immediate' as const : 'unsupported' as const,
          interruptionPolicy: turn.interruptionPolicy ?? (turn.bargeIn ? 'client_two_stage' as const : 'disabled' as const),
        });
      },
    }),
  }),
]) satisfies readonly BundledVoiceUiEntry[];
