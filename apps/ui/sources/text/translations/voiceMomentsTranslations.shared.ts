

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
    setupLightCaption: (params: Readonly<{ done: number; total: number }>) => string;
    setupServiceTitle: string;
    setupServiceDetail: string;
    setupChange: string;
    setupReadinessTitle: (params: Readonly<{ service: string }>) => string;
    setupReadinessDone: (params: Readonly<{ service: string }>) => string;
    setupReadinessGeneric: string;
    setupReadinessTitleGeneric: string;
    setupReadinessUnknown: string;
    setupReadinessCheck: string;
    setupMicrophoneTitle: string;
    setupMicrophoneDetail: string;
    setupMicrophoneAction: string;
    setupMicrophoneDone: string;
    setupMicrophoneDeniedTitle: string;
    setupMicrophoneDeniedDetail: string;
    setupOpenSystemSettings: string;
    setupTryTitle: string;
    setupTryDetail: string;
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
    needsYouEnded: string;
    needsYouReview: string;
    needsYouTapToDecide: string;
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
    dismiss: string;
}>;


export const voiceMomentsTranslationsEnglish = { en: {
        setupTitle: 'Set up voice',
        setupTileSubtitle: 'Talk to your sessions out loud. Four short steps.',
        setupTileProgress: ({ done, total, next }) => `${done} of ${total} done · ${next}`,
        setupNextService: 'choose who listens next',
        setupNextReadiness: 'finish the service next',
        setupNextMicrophone: 'allow the microphone next',
        setupNextTry: 'try it next',
        setupNextInstalling: 'installing',
        setupStart: 'Set up',
        setupContinue: 'Continue',
        setupDescription: 'Talk to your sessions out loud: ask what’s happening, start work, decide from anywhere. Four steps; you can leave and come back.',
        setupLightCaption: ({ done, total }) => `${done} of ${total} ready`,
        setupServiceTitle: 'Choose who listens',
        setupServiceDetail: 'What hears you and speaks back. You can change it later.',
        setupChange: 'Change',
        setupReadinessTitle: ({ service }) => `Finish setting up ${service}`,
        setupReadinessDone: ({ service }) => `${service} is ready`,
        setupReadinessGeneric: 'The service',
        setupReadinessTitleGeneric: 'Get the service ready',
        setupReadinessUnknown: 'Open its settings to check what it still needs.',
        setupReadinessCheck: 'Check setup',
        setupMicrophoneTitle: 'Allow the microphone',
        setupMicrophoneDetail: 'Your device asks once. Happier listens only while Voice is on, and you can always see when it is.',
        setupMicrophoneAction: 'Allow microphone',
        setupMicrophoneDone: 'Microphone allowed',
        setupMicrophoneDeniedTitle: 'The microphone is off for Happier',
        setupMicrophoneDeniedDetail: 'Turn it on in your system settings, then come back here.',
        setupOpenSystemSettings: 'Open settings',
        setupTryTitle: 'Try it',
        setupTryDetail: 'Ask “What are my sessions doing?” Your words land in the conversation like any message.',
        setupTryAction: 'Try it',
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
        needsYouEnded: 'Voice ended. Approval is still needed in Inbox.',
        needsYouReview: 'Review request',
        needsYouTapToDecide: 'Read aloud · decide here, not by voice',
        briefMe: 'Brief me',
        briefMeA11y: 'Brief me: Voice reads what needs you, what failed and what’s ready',
        briefNeedsYou: 'Needs you',
        briefFailed: 'Failed',
        briefReady: 'Ready',
        briefIncomplete: 'Some work hasn’t loaded yet, so this may not be everything.',
        briefCaughtUp: 'Nothing needs you right now.',
        briefNotSpoken: 'Voice can’t read this right now. The list is all here.',
        briefStop: 'Stop',
        continueTitle: 'Continue talking here',
        continueDetail: ({ device }) => `You were talking on ${device}`,
        continueAction: 'Continue',
        continuedOn: ({ device }) => `Continued on ${device}`,
        continuedElsewhere: 'Continued on another device',
        continuedHere: 'Continued on this device',
        dismiss: 'Dismiss',
    } } satisfies Pick<Readonly<Record<string, VoiceMomentsTranslation>>, "en">;