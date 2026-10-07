

export type VoiceSettingsPagesCopy = Readonly<{
  pages: Readonly<{
    search: Readonly<{
      chooseService: string;
      select: (params: { choice: string; control: string }) => string;
    }>;
    hub: Readonly<{
      description: string;
      modesTitle: string;
      moreTitle: string;
      dictationPurpose: string;
      summarySessionSummaries: string;
      summaryRecentMessages: (params: { count: number }) => string;
      summaryNothingShared: string;
      summaryRemembers: string;
      summaryForgets: string;
      summaryVoiceComputer: (params: { machine: string }) => string;
      summaryTranscript: string;
    }>;
    pipeline: Readonly<{
      hear: string;
      think: string;
      speak: string;
      write: string;
      ready: string;
      oneStepNeedsYou: string;
      stepsNeedYou: (params: { count: number }) => string;
      waiting: string;
      working: string;
      notChecked: string;
      off: string;
      onMachine: (params: { machine: string }) => string;
      onVoiceComputer: string;
      inTheCloud: string;
      inTheSession: string;
      intoYourMessage: string;
      messageLanguage: (params: { language: string }) => string;
      languageAutomatic: string;
      onThisDevice: string;
      needsYou: string;
      voiceAgentFollowsSession: string;
      theSessionYoureIn: string;
      intoYourMessageTitle: string;
    }>;
    privacy: Readonly<{
      localAudio: string;
      localProcessor: string;
      localRetention: string;
      localDisclosure: string;
      audioTitle: string;
      processorTitle: string;
      retentionTitle: string;
      messagesUnit: string;
      secondsUnit: string;
      servicePolicy: string;
      noMicrophoneAudio: string;
      yourEndpoint: string;
      endpointOperator: string;
      endpointPolicy: string;
      deviceAudio: string;
      deviceProcessor: string;
      devicePolicy: string;
      description: string;
      whereTitle: string;
      whereDescription: string;
      startTitle: string;
      startDescription: string;
      screenTitle: string;
      screenDescription: string;
      screenNever: string;
      screenWhenAsked: string;
      screenAlways: string;
      summariesTitle: string;
      recentTitle: string;
      recentDescription: string;
      recentCountTitle: string;
      recentCountDescription: string;
      recentCountUnavailable: string;
      toolsTitle: string;
      toolsDescription: string;
      permissionsTitle: string;
      permissionsDescription: string;
      devicesTitle: string;
      devicesDescription: string;
      liveTitle: string;
      liveDescription: string;
      liveActiveTitle: string;
      liveOtherTitle: string;
      liveNothing: string;
      liveActivity: string;
      liveSummaries: string;
      liveMessages: string;
      livePerUpdateTitle: string;
      liveIncludeMineTitle: string;
      liveIncludeMineDescription: string;
      liveMessagesUnavailable: string;
      liveOtherModeTitle: string;
      liveOtherModeNever: string;
      liveOtherModeWhenAsked: string;
      liveOtherModeAutomatically: string;
      liveOtherModeUnavailable: string;
      memoryTitle: string;
      memoryDescription: string;
      rememberTitle: string;
      rememberOnDescription: string;
      rememberOffDescription: string;
      restoreTitle: string;
      restoreRecent: string;
      restoreSummary: string;
      restoreResume: string;
      restoreUnavailable: string;
      restoreResumeFeatureOff: string;
      restoreResumeAgentCannot: string;
      fallbackTitle: string;
      fallbackDescription: string;
      restoreCountTitle: string;
      restoreCountDescription: string;
      forgetTitle: string;
      forgetDescription: string;
      forgetAction: string;
      moreTitle: string;
    }>;
    dictation: Readonly<{
      description: string;
      engineTitle: string;
      engineDescription: string;
      sameAsConversations: string;
      sameAsConversationsUses: (params: { engine: string }) => string;
      languageTitle: string;
      dictateInTitle: string;
      dictateInDescription: string;
      pipelinePurpose: string;
    }>;
    conversations: Readonly<{
      description: string;
      serviceTitle: string;
      serviceDescription: string;
      offDescription: string;
      serviceReady: string;
      accountTitle: string;
      accountDescription: string;
      payWithTitle: string;
      happierBillingUnavailable: string;
      turnOnVoiceAgent: string;
      payWithHappierDescription: string;
      payWithOwnDescription: string;
      runsOn: string;
      hearTitle: string;
      hearDescription: string;
      speechRecognitionTitle: string;
      handsFreeUnsupported: string;
      handsFreeTimingUnavailable: string;
      interruptTitle: string;
      interruptDescription: string;
      talkToTitle: string;
      talkToSession: string;
      talkToSessionDescription: string;
      talkToAgent: string;
      talkToAgentDescription: string;
      agentFeatureRequired: (params: { feature: string }) => string;
      itMayTitle: string;
      itMayReadOnly: string;
      itMayReadOnlyDescription: string;
      itMayAsk: string;
      itMayAskDescription: string;
      itMaySafe: string;
      itMaySafeDescription: string;
      itMayAnything: string;
      itMayAnythingDescription: string;
      repliesTitle: string;
      repliesShort: string;
      repliesBalanced: string;
      thinkTitle: string;
      thinkDescription: string;
      advancedAgentTitle: string;
      advancedAgentDescription: string;
      memoryLinkTitle: string;
      memoryLinkDescription: string;
      speakTitle: string;
      speakDescription: string;
      voiceEngineTitle: string;
      languageTitle: string;
      languageDescription: string;
      iSpeakTitle: string;
      iSpeakDescription: string;
      replyInTitle: string;
      replyInDescription: string;
      replySame: string;
      iSpeakAutomatic: string;
      iSpeakEngineDescription: (params: { engine: string }) => string;
      voiceTitle: string;
      voiceDescription: (params: { engine: string }) => string;
      voiceDefault: string;
      voiceDevice: string;
      voiceInEngine: string;
      languageServiceDescription: string;
      languageAutomaticDescription: string;
      languageEngineDefault: string;
      languageCoupledDescription: string;
      greetingTitle: string;
      greetingOff: string;
      greetingRightAway: string;
      greetingAfterISpeak: string;
      greetingOffDescription: string;
      greetingRightAwayDescription: string;
      greetingAfterISpeakDescription: string;
      languageManagedDescription: string;
      languageServiceDefault: string;
    }>;
    advanced: Readonly<{
      description: string;
      onScreenTitle: string;
      onScreenDescription: string;
      showLiveAsTitle: string;
      showLiveAsDescription: string;
      scopeTitle: string;
      scopeGlobal: string;
      scopeGlobalDescription: string;
      scopeSession: string;
      scopeSessionDescription: string;
      transcriptTitle: string;
      transcriptDescription: string;
      autoOpenTitle: string;
      autoOpenDescription: string;
      autoOpenUnavailable: string;
      computerTitle: string;
      speechModelsTitle: string;
      speechModelsNeedComputerTitle: string;
      speechModelsNeedComputer: string;
      computerDescription: string;
      connectionTitle: string;
      timeoutTitle: string;
      timeoutDescription: string;
    }>;
  }>;
}>;



export const en: VoiceSettingsPagesCopy = {
  pages: {
    search: {
      chooseService: 'Choose a service to change this setting.',
      select: ({ choice, control }) => `Select ${choice} in ${control} to change this setting.`,
    },
    hub: {
      description: 'Talk with your agents out loud, and dictate into any message.',
      modesTitle: 'Two ways to use your voice',
      moreTitle: 'More',
      dictationPurpose: 'the mic in the composer turns your speech into text you can edit',
      summarySessionSummaries: 'Session summaries',
      summaryRecentMessages: ({ count }) => `last ${count} messages`,
      summaryNothingShared: 'Nothing shared when a conversation starts',
      summaryRemembers: 'Voice agent remembers past conversations',
      summaryForgets: 'Voice agent forgets after each conversation',
      summaryVoiceComputer: ({ machine }) => `Voice computer: ${machine}`,
      summaryTranscript: 'transcript while talking',
    },
    pipeline: {
      hear: 'Hear',
      think: 'Think',
      speak: 'Speak',
      write: 'Write',
      ready: 'Ready',
      oneStepNeedsYou: 'One step needs you',
      stepsNeedYou: ({ count }) => `${count} steps need you`,
      waiting: 'Waiting',
      working: 'Working',
      notChecked: 'Not checked yet',
      off: 'Off · Dictation stays available',
      onMachine: ({ machine }) => `On ${machine}`,
      onVoiceComputer: 'On your Voice computer',
      inTheCloud: 'In the service’s cloud, from this device',
      inTheSession: 'Its own agent answers, in the transcript',
      intoYourMessage: 'You review it before sending',
      messageLanguage: ({ language }) => `Language: ${language}`,
      languageAutomatic: 'automatic',
      onThisDevice: 'On this device',
      needsYou: 'Needs you',
      voiceAgentFollowsSession: 'Voice agent · follows the session',
      theSessionYoureIn: 'The session you’re in',
      intoYourMessageTitle: 'Into your message',
    },
    privacy: {
      localAudio: "Your device or Voice computer",
      localProcessor: "Your selected speech model",
      localRetention: "Managed by your device/runtime. Diagnostics follow your recording settings.",
      localDisclosure: "Selected speech models run on your device or Voice computer. Voice History and diagnostic recordings have separate settings on this page.",
      audioTitle: "Audio goes to",
      processorTitle: "Processed by",
      retentionTitle: "Retention",
      messagesUnit: "messages",
      secondsUnit: "seconds",
      servicePolicy: "Follows your service account settings and terms.",
      noMicrophoneAudio: "No microphone audio; reply text only.",
      yourEndpoint: "Your configured endpoint",
      endpointOperator: "Your endpoint operator",
      endpointPolicy: "Follows your endpoint’s retention policy.",
      deviceAudio: "Your device’s speech service",
      deviceProcessor: "Your device or its speech service",
      devicePolicy: "Follows your device’s speech settings and terms.",
      description: 'What your voice service hears and reads, and what Happier keeps.',
      whereTitle: 'Where your voice goes now',
      whereDescription: 'It changes with the service you choose.',
      startTitle: 'When a conversation starts',
      startDescription: 'What the voice service can read about your work.',
      screenTitle: 'What’s on your screen',
      screenDescription: 'Which session or page you’re looking at.',
      screenNever: 'Never',
      screenWhenAsked: 'When asked',
      screenAlways: 'Always',
      summariesTitle: 'Session summaries',
      recentTitle: 'Your recent messages',
      recentDescription: 'The last messages of a session, when it asks for context.',
      recentCountTitle: 'Messages to share',
      recentCountDescription: "",
      recentCountUnavailable: 'Turn on “Your recent messages” to change this.',
      toolsTitle: 'Tool names',
      toolsDescription: 'Like “Edited file”. Arguments and file paths are never shared.',
      permissionsTitle: 'Permission requests',
      permissionsDescription: 'So it can tell you what needs you. You still approve with a tap.',
      devicesTitle: 'Your machines and devices',
      devicesDescription: 'Names and online state, to start sessions where you ask.',
      liveTitle: 'While you talk',
      liveDescription: 'Updates sent as your sessions change during a conversation.',
      liveActiveTitle: 'From the session you’re in',
      liveOtherTitle: 'From your other sessions',
      liveNothing: 'Nothing',
      liveActivity: 'Activity',
      liveSummaries: 'Summaries',
      liveMessages: 'Messages',
      livePerUpdateTitle: 'Messages per update',
      liveIncludeMineTitle: 'Include what you wrote',
      liveIncludeMineDescription: 'Off: only the agent’s side is sent.',
      liveMessagesUnavailable: 'Choose “Messages” for a session above to change this.',
      liveOtherModeTitle: 'Messages from other sessions',
      liveOtherModeNever: 'Never',
      liveOtherModeWhenAsked: 'When asked',
      liveOtherModeAutomatically: 'Automatically',
      liveOtherModeUnavailable: 'Choose “Messages” for other sessions to change this.',
      memoryTitle: 'Voice agent memory',
      memoryDescription: 'Only for Local voice with a Voice agent.',
      rememberTitle: 'Remember past conversations',
      rememberOnDescription: 'It picks up where you left off.',
      rememberOffDescription: 'Off: it forgets everything when you hang up.',
      restoreTitle: 'Restore memory by',
      restoreRecent: 'Recent messages',
      restoreSummary: 'Summary + recent',
      restoreResume: 'Resuming the agent',
      restoreUnavailable: 'Turn on “Remember” to choose.',
      restoreResumeFeatureOff: 'Resuming needs the Voice agent turned on for this server.',
      restoreResumeAgentCannot: 'This agent can’t resume a past conversation.',
      fallbackTitle: 'If resuming fails, replay messages',
      fallbackDescription: 'Starts from your recent messages instead of from nothing.',
      restoreCountTitle: 'Messages to restore',
      restoreCountDescription: "",
      forgetTitle: 'Forget everything now',
      forgetDescription: 'Starts the Voice agent fresh. Your sessions are not touched.',
      forgetAction: 'Forget',
      moreTitle: 'More',
    },
    dictation: {
      description: 'The mic in the composer turns your speech into text you can edit before sending.',
      engineTitle: 'Speech engine',
      engineDescription: 'Each engine says where your audio goes.',
      sameAsConversations: 'Same as voice conversations',
      sameAsConversationsUses: ({ engine }) => `Uses ${engine}, like your voice conversations.`,
      languageTitle: 'Language',
      dictateInTitle: 'I dictate in',
      dictateInDescription: 'Automatic uses the engine’s default. This doesn’t follow your conversation language.',
      pipelinePurpose: 'works even when voice conversations are off',
    },
    conversations: {
      description: 'Talk to your agents out loud, hands on the keyboard or not.',
      serviceTitle: 'Service',
      serviceDescription: 'Who hears you, thinks and speaks. You can switch any time; each keeps its own setup.',
      offDescription: 'No voice conversations. Dictation stays available.',
      serviceReady: 'Ready',
      accountTitle: 'Account',
      accountDescription: 'It is the same service either way; this only changes who pays.',
      payWithTitle: 'Pay with',
      happierBillingUnavailable: "Happier billing isn’t available on this server.",
      turnOnVoiceAgent: "Turn on Voice agent",
      payWithHappierDescription: 'Your Happier plan covers it. No account of your own needed.',
      payWithOwnDescription: 'You use your own account and API key with this service.',
      runsOn: 'Runs on',
      hearTitle: 'Hear',
      hearDescription: 'How your speech becomes text before it is answered.',
      speechRecognitionTitle: 'Speech recognition',
      handsFreeUnsupported: 'Hands-free needs speech recognition on this device or a Happier speech model.',
      handsFreeTimingUnavailable: 'Turn on Hands-free to change this.',
      interruptTitle: 'Interrupt by speaking',
      interruptDescription: 'Talking over a reply stops it.',
      talkToTitle: 'Talk to',
      talkToSession: 'The session',
      talkToSessionDescription: 'You speak into the session you’re in; its own agent answers.',
      talkToAgent: 'A Voice agent',
      talkToAgentDescription: 'A Voice agent reads your sessions and acts on them for you.',
      agentFeatureRequired: ({ feature }) => `Enable ${feature} in Settings → Features. Experimental features also need Experiments turned on.`,
      itMayTitle: 'It may',
      itMayReadOnly: 'Read only',
      itMayReadOnlyDescription: 'It reads your sessions and files and changes nothing.',
      itMayAsk: 'Ask first',
      itMayAskDescription: 'Every change asks you first. A spoken “yes” never approves; you tap.',
      itMaySafe: 'Safe changes',
      itMaySafeDescription: 'It makes safe workspace changes on its own and asks for the rest.',
      itMayAnything: 'Anything',
      itMayAnythingDescription: 'It may make any change without asking you first.',
      repliesTitle: 'Replies',
      repliesShort: 'Short',
      repliesBalanced: 'Balanced',
      thinkTitle: 'Think',
      thinkDescription: 'What happens to what you say.',
      advancedAgentTitle: 'Advanced agent behavior',
      advancedAgentDescription: 'How the Voice agent starts, waits and answers. The defaults suit most people.',
      memoryLinkTitle: 'Memory and restoring',
      memoryLinkDescription: 'Whether it remembers past conversations lives in Privacy & data.',
      speakTitle: 'Speak',
      speakDescription: 'How replies are read aloud.',
      voiceEngineTitle: 'Voice engine',
      languageTitle: 'Language',
      languageDescription: 'What each language changes for the service you chose.',
      iSpeakTitle: 'I speak',
      iSpeakDescription: 'Helps it understand you. Automatic detects it each time.',
      replyInTitle: 'Reply in',
      replyInDescription: 'The answer comes back in this language, even if you switch.',
      replySame: 'Same as I speak',
      iSpeakAutomatic: 'Automatic',
      iSpeakEngineDescription: ({ engine }) => `Helps ${engine} understand you. Set it with speech recognition in Hear.`,
      voiceTitle: 'Voice',
      voiceDescription: ({ engine }) => `From ${engine}, the engine in Speak.`,
      voiceDefault: 'Default',
      voiceDevice: 'This device’s voice',
      voiceInEngine: 'Set in Speak',
      languageServiceDescription: 'The language your voice service answers in.',
      languageAutomaticDescription: 'Your voice service detects the language you speak.',
      languageEngineDefault: 'Engine default',
      languageCoupledDescription: 'Your voice service uses one language for listening and replies.',
      greetingTitle: 'Greeting',
      greetingOff: 'Off',
      greetingRightAway: 'Right away',
      greetingAfterISpeak: 'After I speak',
      greetingOffDescription: 'It waits for you to speak first.',
      greetingRightAwayDescription: 'It says hello as soon as the conversation starts.',
      greetingAfterISpeakDescription: 'It greets you in its first reply.',
      languageManagedDescription: 'Your voice service controls its language.',
      languageServiceDefault: 'Service default',
    },
    advanced: {
      description: 'Where voice runs, how it shows on screen, and the speech models it uses.',
      onScreenTitle: 'On screen',
      onScreenDescription: 'How a live conversation shows up.',
      showLiveAsTitle: 'Show live Voice as',
      showLiveAsDescription: 'On this device only. The Companion’s Voice section stays in every mode.',
      scopeTitle: 'Start conversations with',
      scopeGlobal: 'All my sessions',
      scopeGlobalDescription: 'One assistant for everything.',
      scopeSession: 'The open session',
      scopeSessionDescription: 'It starts inside the session you have open.',
      transcriptTitle: 'Show the transcript while talking',
      transcriptDescription: 'What you and the agent say appears as you talk.',
      autoOpenTitle: 'Open it when a conversation starts',
      autoOpenDescription: 'Off: open it yourself from the conversation.',
      autoOpenUnavailable: 'Turn on “Show the transcript” to choose.',
      computerTitle: 'Voice computer',
      speechModelsTitle: 'Speech models',
      speechModelsNeedComputerTitle: 'Needs a Voice computer',
      speechModelsNeedComputer: 'Choose a Voice computer above to install and manage its speech models.',
      computerDescription: 'The computer that runs speech models and signs in to connected accounts for voice. Shared across your devices.',
      connectionTitle: 'Connection',
      timeoutTitle: 'Give up on a speech request after',
      timeoutDescription: "For endpoints and speech models.",
    },
  },
};


export const voiceSettingsPagesTranslationsEnglish = { en } as const satisfies Pick<Record<string, VoiceSettingsPagesCopy>, "en">;