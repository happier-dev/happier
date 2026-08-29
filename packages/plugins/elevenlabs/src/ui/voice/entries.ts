export const VOICE_PROVIDER_PRESENTATIONS = Object.freeze([
  Object.freeze({
    providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
    settingsSectionId: 'voice.provider.realtime_elevenlabs',
    selectionOptions: [
      {
        id: 'happier',
        modeId: 'happier',
        order: 10,
        titleKey: 'settingsVoice.mode.happier',
        subtitleKey: 'settingsVoice.mode.happierSubtitle',
        configPatch: { billingMode: 'happier' },
      },
      {
        id: 'byo',
        modeId: 'byo',
        order: 20,
        titleKey: 'settingsVoice.mode.byo',
        subtitleKey: 'settingsVoice.mode.byoSubtitle',
        configPatch: { billingMode: 'byo' },
      },
    ],
  }),
]);
