import { XAI_REALTIME_DEFAULT_SETTINGS, XaiRealtimeSettingsV1Schema } from '../../protocol/voice/settings.js';
import { createXaiRealtimeSettingsSection } from './settings.js';

const legacySettingsMigration = Object.freeze({
  defaultLegacyConfig: XAI_REALTIME_DEFAULT_SETTINGS,
  legacyDefaultSelection: false,
  migrateLegacy(value: unknown) {
    const parsed = XaiRealtimeSettingsV1Schema.safeParse(value);
    return parsed.success
      ? Object.freeze({
          config: Object.freeze({
            ...parsed.data,
            instructions: parsed.data.instructions ?? '',
          }),
          root: Object.freeze({}),
        })
      : null;
  },
  projectLegacy() {
    return null;
  },
  mergeLegacy(_currentValue: unknown, migratedValue: unknown) {
    const parsed = XaiRealtimeSettingsV1Schema.safeParse(migratedValue);
    return parsed.success
      ? Object.freeze({
          ...parsed.data,
          instructions: parsed.data.instructions ?? '',
        })
      : null;
  },
});

export const VOICE_PROVIDER_PRESENTATIONS = Object.freeze([
  Object.freeze({
    providerId: 'happier.voice.xai/realtime-grok',
    settingsSectionId: 'voice.provider.realtime_grok',
    selectionOptions: [{
      id: 'byo', modeId: 'byo', order: 22,
      titleKey: 'settingsVoice.mode.grokRealtime',
      subtitleKey: 'settingsVoice.mode.grokRealtimeSubtitle',
    }],
    legacySettingsMigration,
    createSettingsSection: createXaiRealtimeSettingsSection,
  }),
]);
