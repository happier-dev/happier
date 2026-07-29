import { OpenAiRealtimeSettingsV1Schema, OPENAI_REALTIME_DEFAULT_SETTINGS } from '../../protocol/voice/settings.js';
import type { BundledVoiceUiEntry } from '@happier-dev/bundled-voice-runtime-contract';
import { PluginVoiceProviderContributionV1Schema } from '@happier-dev/protocol';
import { PLUGIN_MANIFEST } from '../../manifest.js';
import { createOpenAiRealtimeSettingsSection } from './settingsSection.js';
import { projectOpenAiRealtimeCredentialReadiness } from './credentialReadiness.js';
import {
  OPENAI_REALTIME_CLIENT_AUTH_ACTION_ID,
  OPENAI_REALTIME_CODEX_CLIENT_AUTH_ACTION_ID,
} from '../../voice/realtimeClientAuthAction.js';

const providerSettings = Object.freeze({
  schemaVersion: 1 as const,
  defaultConfig: OPENAI_REALTIME_DEFAULT_SETTINGS,
  defaultLegacyConfig: OPENAI_REALTIME_DEFAULT_SETTINGS,
  legacyDefaultSelection: false,
  parseConfig(value: unknown) {
    const parsed = OpenAiRealtimeSettingsV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
  },
  migrateLegacy(value: unknown) {
    const parsed = OpenAiRealtimeSettingsV1Schema.safeParse(value);
    return parsed.success ? Object.freeze({ config: parsed.data, root: Object.freeze({}) }) : null;
  },
  projectLegacy() {
    return null;
  },
  mergeLegacy(_currentValue: unknown, migratedValue: unknown) {
    const parsed = OpenAiRealtimeSettingsV1Schema.safeParse(migratedValue);
    return parsed.success ? parsed.data : null;
  },
  projectAnalytics(value: unknown) {
    const parsed = OpenAiRealtimeSettingsV1Schema.safeParse(value);
    return parsed.success ? Object.freeze({
      realtimeOpenAiModelKind: parsed.data.model.kind,
      realtimeOpenAiTurnDetection: parsed.data.turnDetection,
    }) : Object.freeze({});
  },
});

const parsedVoiceProviderDeclaration = PluginVoiceProviderContributionV1Schema.parse(
  PLUGIN_MANIFEST.contributes.voiceProviders[0],
);
if (parsedVoiceProviderDeclaration.kind !== 'conversation') {
  throw new Error('openai_realtime_voice_conversation_declaration_required');
}
const openAiVoiceProviderDeclaration = parsedVoiceProviderDeclaration;

export const BUNDLED_VOICE_UI_ENTRIES = Object.freeze([
  Object.freeze({
    kind: 'voice.conversation-provider.v1' as const,
    pluginId: 'happier.voice.openai',
    providerId: 'realtime_openai',
    declaration: openAiVoiceProviderDeclaration,
    settingsSectionId: 'voice.provider.realtime_openai',
    roles: ['conversation_stt', 'conversation_tts', 'realtime_conversation', 'turn_control'],
    requirements: ['credential'],
    supportedPlatforms: ['web'],
    selectionOptions: [{
      id: 'byo', modeId: 'byo', order: 21,
      titleKey: 'settingsVoice.mode.openaiRealtime',
      subtitleKey: 'settingsVoice.mode.openaiRealtimeSubtitle',
    }],
    projectSettings(envelope: Readonly<{ schemaVersion: number; config: unknown }> | null) {
      if (!envelope || envelope.schemaVersion < 1) return { status: 'needs_migration' as const, modeId: null };
      if (envelope.schemaVersion > 1) return { status: 'unsupported_version' as const, modeId: null };
      return OpenAiRealtimeSettingsV1Schema.safeParse(envelope.config).success
        ? { status: 'ready' as const, modeId: 'byo' }
        : { status: 'invalid' as const, modeId: null };
    },
    internal: Object.freeze({
      providerSettings,
      createSettingsSection: createOpenAiRealtimeSettingsSection,
      projectCredentialReadiness: projectOpenAiRealtimeCredentialReadiness,
      resolveAccountOperationTarget(providerConfig: unknown) {
        const parsed = OpenAiRealtimeSettingsV1Schema.safeParse(providerConfig);
        if (!parsed.success) {
          throw new Error('openai_realtime_authentication_source_invalid');
        }
        if (parsed.data.authentication.source === 'voice_saved_secret') {
          return Object.freeze({ kind: 'savedSecret' as const });
        }
        return Object.freeze({
          kind: 'daemonAction' as const,
          actionLocalId: parsed.data.authentication.source === 'connected_service_api_key'
            ? OPENAI_REALTIME_CLIENT_AUTH_ACTION_ID
            : OPENAI_REALTIME_CODEX_CLIENT_AUTH_ACTION_ID,
        });
      },
      resolveSurfaceCapabilities(providerConfig: unknown) {
        if (!OpenAiRealtimeSettingsV1Schema.safeParse(providerConfig).success) return null;
        return Object.freeze({
          allowsGlobalStart: true,
          controlSessionScope: 'global' as const,
          requiresVoiceAgentFeature: false,
          bargeInEnabled: true,
          cancelResponse: 'immediate' as const,
          interruptionPolicy: 'client_two_stage' as const,
        });
      },
    }),
  }),
]) satisfies readonly BundledVoiceUiEntry[];
