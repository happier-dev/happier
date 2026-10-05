export const VOICE_PROVIDER_PRESENTATIONS = Object.freeze([
  Object.freeze({
    providerId: 'happier.voice.elevenlabs/realtime-elevenlabs',
    settingsSectionId: 'voice.provider.realtime_elevenlabs',
    resources: {
      titleKey: 'settingsVoice.realtimeProviders.elevenLabs.resourcesTitle',
      accountTitleKey: 'settingsVoice.realtimeProviders.elevenLabs.openAccount',
      apiKeysTitleKey: 'settingsVoice.realtimeProviders.elevenLabs.manageApiKeys',
    },
    agentAction: {
      settingId: 'agentId', createActionId: 'create-agent', updateActionId: 'update-agent',
      titleKey: 'settingsVoice.realtimeProviders.elevenLabs.agentTitle',
      missingStateKey: 'settingsVoice.realtimeProviders.elevenLabs.agentMissing',
      configuredStateKey: 'settingsVoice.realtimeProviders.elevenLabs.agentConfigured',
    },
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
