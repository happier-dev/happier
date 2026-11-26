

export type VoiceMomentsTranslation = Readonly<{
    setupTitle: string;
    setupTileSubtitle: string;
    setupTileProgress: (params: Readonly<{ done: number; total: number; next: string }>) => string;
    setupNextService: string;
    setupNextReadiness: string;
    setupNextMicrophone: string;
    setupNextTry: string;
    setupNextInstalling: string;
    setupStart: string;
    setupContinue: string;
    setupDescription: string;
    setupPanelTitle: string;
    setupServiceTitle: string;
    setupServiceDetail: string;
    setupChange: string;
    setupReadinessTitle: (params: Readonly<{ service: string }>) => string;
    setupReadinessDone: string;
    setupReadinessDoneOnMachine: (params: Readonly<{ machine: string }>) => string;
    setupReadinessTitleGeneric: string;
    setupReadinessUnknown: string;
    setupReadinessCheck: string;
    setupMicrophoneTitle: string;
    setupMicrophoneDetail: string;
    setupMicrophoneAction: string;
    setupMicrophoneDone: string;
    setupMicrophoneDeniedTitle: string;
    setupMicrophoneDeniedDetail: string;
    setupMicrophoneMissingTitle: string;
    setupMicrophoneMissingDetail: string;
    setupMicrophoneCheckAgain: string;
    setupOpenSystemSettings: string;
    setupTryTitle: string;
    setupTryLead: string;
    setupTryPhrase: string;
    setupTryAction: string;
    setupTryDone: string;
    setupTryNeedsService: string;
    setupDoneTitle: string;
    setupDoneBody: string;
    setupGestureTap: string;
    setupGestureStartEnd: string;
    setupGestureAnywhere: string;
    setupDoneAction: string;
    setupSettingsAction: string;
    setupClose: string;
    setupNotNow: string;
    setupFooterNote: string;
    /** In a running Try: the try is already the person's conversation with the Session. */
    setupInCallNote: string;
    needsYouEnded: string;
    needsYouReview: string;
    briefWantsTo: (params: { action: string }) => string;
    briefRunCommand: (params: { command: string }) => string;
    briefMe: string;
    briefMeA11y: string;
    briefNeedsYou: string;
    briefFailed: string;
    briefReady: string;
    briefIncomplete: string;
    briefCaughtUp: string;
    briefNotSpoken: string;
    briefStop: string;
    continueTitle: string;
    continueDetail: (params: Readonly<{ device: string }>) => string;
    continueAction: string;
    continuedOn: (params: Readonly<{ device: string }>) => string;
    continuedElsewhere: string;
    continuedHere: string;
    /** The transcript row when Voice moves to another Session: only where it is now. */
    nowTalkingTo: (params: Readonly<{ title: string }>) => string;
    nowTalkingToAnother: string;
    notTalkingToSession: string;
    spokenTurn: string;
    spokenAloud: string;
    /** The account-wide Voice a conversation belongs to, in a Voice conversation's header. */
    globalVoice: string;
    dismiss: string;
}>;


export const voiceMomentsTranslationsEnglish = { en: {
        setupTitle: 'Set up Voice',
        setupTileSubtitle: 'Talk to your sessions out loud. Four short steps.',
        setupTileProgress: ({ done, total, next }) => `${done} of ${total} done · ${next}`,
        setupNextService: 'choose who listens next',
        setupNextReadiness: 'finish the service next',
        setupNextMicrophone: 'allow the microphone next',
        setupNextTry: 'try it next',
        setupNextInstalling: 'installing',
        setupStart: 'Set up',
        setupContinue: 'Continue',
        setupDescription: 'Ask what’s happening, start work, or think out loud. Your words show up in the chat like any message.',
        setupPanelTitle: 'Talk to your sessions',
        setupServiceTitle: 'Choose who listens',
        setupServiceDetail: 'What hears you and speaks back. You can change it later.',
        setupChange: 'Change',
        setupReadinessTitle: ({ service }) => `Finish setting up ${service}`,
        setupReadinessDone: 'Everything it needs is set up',
        setupReadinessDoneOnMachine: ({ machine }) => `Speech models installed on ${machine}`,
        setupReadinessTitleGeneric: 'Get the service ready',
        setupReadinessUnknown: 'Open its settings to check what it still needs.',
        setupReadinessCheck: 'Check setup',
        setupMicrophoneTitle: 'Allow the microphone',
        setupMicrophoneDetail: 'Your device asks once. Happier listens only while Voice is on, and you can always see when it is.',
        setupMicrophoneAction: 'Allow microphone',
        setupMicrophoneDone: 'Microphone allowed',
        setupMicrophoneDeniedTitle: 'The microphone is off for Happier',
        setupMicrophoneDeniedDetail: 'Turn it on in your system settings, then come back here.',
        setupMicrophoneMissingTitle: 'No microphone found',
        setupMicrophoneMissingDetail: 'Connect a microphone or headset, then check again.',
        setupMicrophoneCheckAgain: 'Check again',
        setupOpenSystemSettings: 'Open settings',
        setupTryTitle: 'Try it',
        setupTryLead: 'Say it out loud',
        setupTryPhrase: 'What are my sessions doing?',
        setupTryAction: 'Start talking',
        setupTryDone: 'Tried it',
        setupTryNeedsService: 'Available once the service is ready.',
        setupDoneTitle: 'Voice is ready',
        setupDoneBody: 'Tap the voice button in any chat to start talking, and tap it again to end. Mute sits beside End while you talk.',
        setupGestureTap: 'Tap',
        setupGestureStartEnd: 'start · end',
        setupGestureAnywhere: 'start · end anywhere',
        setupDoneAction: 'Done',
        setupSettingsAction: 'Voice settings',
        setupClose: 'Close',
        setupNotNow: 'Not now',
        setupFooterNote: 'Nothing is sent until you speak.',
        setupInCallNote: 'This is already your conversation with this session.',
        needsYouEnded: 'An approval is still waiting.',
        needsYouReview: 'Review request',
        briefWantsTo: ({ action }) => `Wants to ${action}`,
        briefRunCommand: ({ command }) => `run ${command}`,
        briefMe: 'Brief me',
        briefMeA11y: 'Brief me: Voice reads what needs you, what failed and what’s ready',
        briefNeedsYou: 'Needs you',
        briefFailed: 'Failed',
        briefReady: 'Ready',
        briefIncomplete: 'Some work hasn’t loaded yet, so this may not be everything.',
        briefCaughtUp: 'Nothing needs you right now.',
        briefNotSpoken: "Voice can’t read this aloud right now.",
        briefStop: 'Stop',
        continueTitle: 'Continue talking here',
        continueDetail: ({ device }) => `You were talking on ${device}`,
        continueAction: 'Continue',
        continuedOn: ({ device }) => `Continued on ${device}`,
        continuedElsewhere: 'Continued on another device',
        continuedHere: 'Continued on this device',
        nowTalkingTo: ({ title }) => `Now talking to ${title}`,
        nowTalkingToAnother: 'Now talking to another session',
        notTalkingToSession: 'Not talking to a session',
        spokenTurn: 'Spoken',
        spokenAloud: 'Spoken aloud',
        globalVoice: 'Global Voice',
        dismiss: 'Dismiss',
    } } satisfies Pick<Readonly<Record<string, VoiceMomentsTranslation>>, "en">;
