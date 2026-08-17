/** xAI Realtime Voice settings presentation. */
import { XAI_SUPPORTED_LANGUAGE_HINTS } from '../../protocol/voice/settings.js';

const vadField = (suffix: string, bounds: Readonly<{ min: number; max: number; integer?: boolean }>) => Object.freeze({
  suffix,
  path: `turnDetection.${suffix}`,
  ...bounds,
  nullable: true,
  titleKey: `settingsVoice.realtimeProviders.fields.turnDetection.${suffix}.title`,
  subtitleKey: `settingsVoice.realtimeProviders.fields.turnDetection.${suffix}.subtitle`,
  promptTitleKey: `settingsVoice.realtimeProviders.fields.turnDetection.${suffix}.promptTitle`,
  promptBodyKey: `settingsVoice.realtimeProviders.fields.turnDetection.${suffix}.promptBody`,
});

export const XAI_REALTIME_SETTINGS_SECTION = Object.freeze({
  kind: 'voice.internal.realtime-settings.v1' as const,
  providerId: 'happier.voice.xai/realtime-grok' as const,
  mode: 'byo' as const,
  titleKey: 'settingsVoice.realtimeProviders.setup.title',
  footerKey: 'settingsVoice.realtimeProviders.xai.setup.footer',
  credential: Object.freeze({
    kind: 'api_key' as const,
    credentialPurpose: 'voice.client-auth' as const,
    catalog: 'voices' as const,
    titleKey: 'settingsVoice.realtimeProviders.credential.title',
    promptTitleKey: 'settingsVoice.realtimeProviders.credential.promptTitle',
    promptBodyKey: 'settingsVoice.realtimeProviders.xai.credential.promptBody',
  }),
  links: Object.freeze({
    account: 'https://console.x.ai',
    apiKeys: 'https://console.x.ai/team/default/api-keys',
    privacy: 'https://x.ai/legal/privacy-policy',
  }),
  fields: Object.freeze([
    Object.freeze({
      kind: 'model' as const,
      path: 'model',
      titleKey: 'settingsVoice.realtimeProviders.fields.model.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.model.subtitle',
      movingAliasRequiresOptIn: true,
      options: Object.freeze([
        Object.freeze({ kind: 'pinned' as const, id: 'grok-voice-think-fast-1.0' }),
        Object.freeze({ kind: 'moving_alias' as const, id: 'grok-voice-latest' }),
      ]),
    }),
    Object.freeze({
      kind: 'voice_catalog' as const,
      path: 'voice',
      customIdAllowed: true,
      titleKey: 'settingsVoice.realtimeProviders.fields.voice.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.voice.subtitle',
    }),
    Object.freeze({
      kind: 'instructions' as const,
      path: 'instructions',
      maxLength: 10_000,
      titleKey: 'settingsVoice.realtimeProviders.fields.instructions.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.instructions.subtitle',
      promptTitleKey: 'settingsVoice.realtimeProviders.fields.instructions.promptTitle',
      promptBodyKey: 'settingsVoice.realtimeProviders.fields.instructions.promptBody',
    }),
    Object.freeze({
      kind: 'segmented' as const,
      path: 'reasoningEffort',
      options: Object.freeze(['high', 'none']),
      supportedModelIds: Object.freeze(['grok-voice-latest', 'grok-voice-think-fast-1.0']),
      titleKey: 'settingsVoice.realtimeProviders.fields.reasoning.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.reasoning.subtitle',
    }),
    Object.freeze({
      kind: 'range' as const, path: 'outputSpeed', min: 0.7, max: 1.5, step: 0.05, reset: 1,
      titleKey: 'settingsVoice.realtimeProviders.fields.outputSpeed.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.outputSpeed.subtitle',
      promptTitleKey: 'settingsVoice.realtimeProviders.fields.outputSpeed.promptTitle',
      promptBodyKey: 'settingsVoice.realtimeProviders.fields.outputSpeed.promptBody',
    }),
    Object.freeze({
      kind: 'language_hint' as const, path: 'transcription.languageHint',
      options: Object.freeze([...XAI_SUPPORTED_LANGUAGE_HINTS]),
      titleKey: 'settingsVoice.realtimeProviders.fields.languageHint.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.languageHint.subtitle',
      promptTitleKey: 'settingsVoice.realtimeProviders.fields.languageHint.promptTitle',
      promptBodyKey: 'settingsVoice.realtimeProviders.fields.languageHint.promptBody',
    }),
    Object.freeze({
      kind: 'keyterms' as const, path: 'transcription.keyterms', maxItems: 100, maxLength: 50,
      titleKey: 'settingsVoice.realtimeProviders.fields.keyterms.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.keyterms.subtitle',
      promptTitleKey: 'settingsVoice.realtimeProviders.fields.keyterms.promptTitle',
      promptBodyKey: 'settingsVoice.realtimeProviders.fields.keyterms.promptBody',
    }),
    Object.freeze({
      kind: 'server_vad' as const, path: 'turnDetection', advanced: true,
      titleKey: 'settingsVoice.realtimeProviders.fields.turnDetection.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.turnDetection.subtitle',
      subfields: Object.freeze([
        vadField('threshold', { min: 0.1, max: 0.9 }),
        vadField('silenceDurationMs', { min: 0, max: 10_000, integer: true }),
        vadField('prefixPaddingMs', { min: 0, max: 10_000, integer: true }),
        Object.freeze({
          ...vadField('idleTimeoutMs', { min: 1, max: 600_000, integer: true }),
          requiresOptIn: true,
          confirmTitleKey: 'settingsVoice.realtimeProviders.fields.turnDetection.idleTimeoutMs.confirmTitle',
          confirmBodyKey: 'settingsVoice.realtimeProviders.fields.turnDetection.idleTimeoutMs.confirmBody',
          confirmActionKey: 'settingsVoice.realtimeProviders.fields.turnDetection.idleTimeoutMs.confirmAction',
        }),
      ]),
    }),
    Object.freeze({
      kind: 'privacy_opt_in' as const,
      path: 'resumptionEnabled',
      defaultValue: false,
      retentionMinutes: 30,
      forgetAction: 'forget_provider_conversation' as const,
      titleKey: 'settingsVoice.realtimeProviders.fields.resumption.title',
      subtitleKey: 'settingsVoice.realtimeProviders.fields.resumption.subtitle',
    }),
  ]),
});

export function createXaiRealtimeSettingsSection() {
  return XAI_REALTIME_SETTINGS_SECTION;
}
