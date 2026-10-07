


export const voiceProviderPrivacyTranslationsEnglish = { en: {
    openai: {
      privacyDisclosure: 'Audio and conversation content are sent from this device to OpenAI using WebRTC. When enabled or used, OpenAI may also receive bounded Voice context updates, client-tool definitions, and delegated results from this device. Happier uses the selected Saved Voice API key, OpenAI Connected Service, or experimental Codex OAuth account to mint short-lived client authentication; connected accounts are accessed through the selected machine. OpenAI processes the live conversation under the selected account and may retain received data according to that account’s settings and OpenAI’s terms. Happier’s server and relay do not carry live audio. Voice context-sharing controls are separate from this provider processing.',
    },
    xai: {
      privacyDisclosure: 'Audio and conversation content are sent from this device to xAI through the xAI Realtime connection. When enabled or used, xAI may also receive bounded Voice context updates, client-tool definitions, and delegated results from this device. Happier uses the xAI API key saved in your Happier account secrets only for the bounded client-auth and voice-catalog operations. xAI processes the live conversation under that account and may retain received data according to the account settings and xAI’s terms. If resumption is enabled, Happier saves the provider conversation ID; forgetting it removes Happier’s saved ID and does not delete data held by xAI. Happier’s server and relay do not carry live audio. Voice context-sharing controls are separate from this provider processing.',
    },
    speechProcessing: {
      deviceStt: 'Audio is processed by the browser or operating system speech-recognition service. Depending on the platform and configured service, processing may occur off-device.',
      deviceTts: 'Reply text is processed by the browser or operating system speech-synthesis service. Depending on the platform and configured service, processing may occur off-device.',
    },
    fields: {
      resumption: {
        title: 'Save xAI resumption ID',
        subtitle: 'Allow Happier to save xAI’s short-lived provider conversation ID for reconnecting.',
      },
    },
    resumption: {
      confirmTitle: 'Save the xAI resumption ID?',
      confirmBody: 'Happier will save xAI’s provider conversation ID for up to {minutes} minutes so an interrupted conversation can reconnect. This does not change or delete data held by xAI.',
      confirmAction: 'Save ID',
      forgetTitle: 'Forget Happier resumption ID',
      forgetSubtitle: 'Remove Happier’s saved provider conversation ID. This does not delete the conversation or data held by xAI.',
      forgotten: 'Happier removed its saved provider conversation ID.',
      unsupported: 'Happier cannot remove the saved provider conversation ID from this session.',
      failed: 'Happier could not remove its saved provider conversation ID. Please try again.',
    },
  } } as const;