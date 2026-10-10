

export type PersonalizeTranslation = Readonly<{
    cardTitle: string;
    cardSubtitle: string;
    cardAction: string;
    cardContinue: string;
    cardProgress: (params: Readonly<{ saved: number; total: number; step: string }>) => string;
    cardProgressReview: (params: Readonly<{ saved: number; total: number }>) => string;
    inPlaceTitle: string;
    inPlaceBody: string;
    inPlaceContinue: (params: Readonly<{ count: number }>) => string;
    notNow: string;
    flowTitle: string;
    finishLater: string;
    later: string;
    stepEyebrow: (params: Readonly<{ n: number; total: number; name: string }>) => string;
    stepCounter: (params: Readonly<{ n: number; total: number }>) => string;
    styleEyebrow: string;
    summaryEyebrow: string;
    previewNote: string;
    previewNoteSummary: string;
    next: string;
    review: string;
    useThisSetup: string;
    saveFailed: string;
    tryAgain: string;
    skipThisStep: string;
    scopeThisDevice: string;
    scopeAllDevices: string;
    stepsLabel: string;
    savedStepsNote: (params: Readonly<{ count: number }>) => string;
    lookName: string;
    lookTitle: string;
    lookDescription: string;
    themeLabel: string;
    glassLabel: string;
    glassAutoDescription: string;
    glassEverywhereDescription: string;
    glassSolidDescription: string;
    glassCustomNote: string;
    customizeInAppearance: string;
    styleName: string;
    styleTitle: string;
    styleDescription: string;
    styleKeep: string;
    styleActivity: string;
    styleConversation: string;
    styleDetail: string;
    styleCustomTag: string;
    styleDefaultTag: string;
    styleChanges: (params: Readonly<{ style: string; count: number }>) => string;
    styleNoChanges: string;
    styleNever: string;
    was: (params: Readonly<{ value: string }>) => string;
    conversationName: string;
    conversationTitle: string;
    conversationDescription: string;
    layoutLabel: string;
    thinkingLabel: string;
    toolsName: string;
    toolsTitle: string;
    toolsDescription: string;
    toolsLabel: string;
    toolTapLabel: string;
    toolDetailLabel: string;
    toolDetailDefault: string;
    toolDetailFull: string;
    workName: string;
    workTitle: string;
    workDescription: string;
    listLayoutLabel: string;
    rowsLabel: string;
    attentionName: string;
    attentionTitle: string;
    attentionDescription: string;
    attentionLabel: string;
    attentionHomeNote: string;
    notificationsName: string;
    notificationsTitle: string;
    notificationsDescription: string;
    notificationsAllowed: string;
    notificationsNotAllowed: string;
    notificationsUnsupported: string;
    scopeLook: string;
    notificationsNeedsYouSummary: string;
    notificationsFinishedSummary: string;
    notificationsAllow: string;
    notificationsTellMe: string;
    notificationsNeedsYou: string;
    notificationsFinished: string;
    notificationsShowLabel: string;
    notificationsShowDescription: string;
    notificationsMessage: string;
    notificationsStatus: string;
    notificationsPhoneNote: string;
    notificationsOff: string;
    sampleNeedsYouTitle: string;
    sampleNeedsYouBody: string;
    sampleReadyTitle: string;
    sampleReadyBody: string;
    sampleStatusBody: string;
    sampleSessionReconnect: string;
    sampleSessionCraft: string;
    sampleSessionReview: string;
    sampleSessionPricing: string;
    sampleSessionDocs: string;
    sampleWorking: string;
    sampleNeedsYou: string;
    sampleReady: string;
    summaryTitle: string;
    summaryDescription: (params: Readonly<{ changed: number }>) => string;
    summaryChange: string;
    summaryFooter: string;
    replayTitle: string;
    replaySubtitle: string;
    replayAction: string;
    journeyHandoff: string;
}>;



export function pluralPl(count: number, one: string, few: string, many: string): string {
    const lastDigit = count % 10;
    const lastTwoDigits = count % 100;
    if (count === 1) return one;
    if (lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)) return few;
    return many;
}



export function pluralRu(count: number, one: string, few: string, many: string): string {
    const lastDigit = count % 10;
    const lastTwoDigits = count % 100;
    if (lastDigit === 1 && lastTwoDigits !== 11) return one;
    if (lastDigit >= 2 && lastDigit <= 4 && (lastTwoDigits < 12 || lastTwoDigits > 14)) return few;
    return many;
}



export const en: PersonalizeTranslation = {
    cardTitle: 'Personalize Happier',
    cardSubtitle: 'Six quick choices, each previewed live.',
    cardAction: 'Personalize',
    cardContinue: 'Continue',
    cardProgress: ({ saved, total, step }) => `${saved} of ${total} choices saved. Pick up at ${step}.`,
    cardProgressReview: ({ saved, total }) => `${saved} of ${total} choices saved. Review your setup.`,
    inPlaceTitle: 'Make Happier yours',
    inPlaceBody: 'Six quick choices, each previewed live. Start with how it looks — Home changes as you pick.',
    inPlaceContinue: ({ count }) => `Continue · ${count} more`,
    notNow: 'Not now',
    flowTitle: 'Personalize Happier',
    finishLater: 'Finish later',
    later: 'Later',
    stepEyebrow: ({ n, total, name }) => `Step ${n} of ${total} · ${name}`,
    stepCounter: ({ n, total }) => `${n} of ${total}`,
    styleEyebrow: 'Optional',
    summaryEyebrow: 'All set',
    previewNote: 'Preview. Nothing is saved until you press Next.',
    previewNoteSummary: 'Your workspace, as it is now.',
    next: 'Next',
    review: 'Review',
    useThisSetup: 'Use this setup',
    saveFailed: 'This step wasn’t saved. Your choice is still selected.',
    tryAgain: 'Try again',
    skipThisStep: 'Skip this step',
    scopeThisDevice: 'This device',
    scopeAllDevices: 'All your devices',
    stepsLabel: 'Steps',
    savedStepsNote: ({ count }) => count === 1 ? '1 step is already saved.' : `${count} steps are already saved.`,
    lookName: 'Look',
    lookTitle: 'Make it comfortable',
    lookDescription: 'Light, dark or whatever your system uses, and how much glass the app shows.',
    themeLabel: 'Theme',
    glassLabel: 'Glass',
    glassAutoDescription: 'Glass across the app, layered',
    glassEverywhereDescription: 'One even glass everywhere',
    glassSolidDescription: 'Every surface opaque',
    glassCustomNote: 'You tuned glass in Appearance. Pick a preset to replace it, or keep yours.',
    customizeInAppearance: 'Customize in Appearance',
    styleName: 'Style',
    styleTitle: 'Start from a style',
    styleDescription: 'Each style sets how sessions read and how the list looks. It only fills in the next steps: nothing is saved until you press Next on each one.',
    styleKeep: 'Keep my current setup',
    styleActivity: 'Activity',
    styleConversation: 'Conversation',
    styleDetail: 'Detail',
    styleCustomTag: 'Custom',
    styleDefaultTag: 'Happier’s default',
    styleChanges: ({ style, count }) => count === 1 ? `${style} changes 1 thing` : `${style} changes ${count} things`,
    styleNoChanges: 'This is already your setup.',
    styleNever: 'Theme, notifications, privacy and agent permissions are never part of a style.',
    was: ({ value }) => `was ${value}`,
    conversationName: 'Conversation',
    conversationTitle: 'Follow the conversation',
    conversationDescription: 'How a session’s turns and the agent’s thinking read.',
    layoutLabel: 'Layout',
    thinkingLabel: 'Thinking',
    toolsName: 'Tool calls',
    toolsTitle: 'See what the agent did',
    toolsDescription: 'How commands, edits and reads appear in a session.',
    toolsLabel: 'Tool calls',
    toolTapLabel: 'Clicking a tool',
    toolDetailLabel: 'Tool detail',
    toolDetailDefault: 'Default',
    toolDetailFull: 'Full',
    workName: 'Your work',
    workTitle: 'Find your work',
    workDescription: 'How the sessions list is organized and how much each row shows.',
    listLayoutLabel: 'Sessions list',
    rowsLabel: 'Rows',
    attentionName: 'Attention',
    attentionTitle: 'Notice what needs you',
    attentionDescription: 'Where sessions waiting for you or ready to review sit in the list.',
    attentionLabel: 'Sessions that need you',
    attentionHomeNote: 'Home always shows what needs you. This only changes the sessions list.',
    notificationsName: 'Notifications',
    notificationsTitle: 'Stay in the loop',
    notificationsDescription: 'What this device tells you when you’re looking at something else.',
    notificationsAllowed: 'Notifications are allowed on this device.',
    notificationsNotAllowed: 'Happier can’t show notifications on this device yet.',
    notificationsUnsupported: 'Notifications aren’t available on this device. Set them up in the desktop app or on your phone.',
    scopeLook: 'Theme on this device · glass on all your devices',
    notificationsNeedsYouSummary: 'Needs you',
    notificationsFinishedSummary: 'Finished',
    notificationsAllow: 'Allow notifications',
    notificationsTellMe: 'Tell me when',
    notificationsNeedsYou: 'A session needs an approval or an answer',
    notificationsFinished: 'A session finishes its turn',
    notificationsShowLabel: 'Notifications show',
    notificationsShowDescription: 'Commands, questions and replies may appear on your lock screen.',
    notificationsMessage: 'The message',
    notificationsStatus: 'Only the status',
    notificationsPhoneNote: 'Alerts on your phone while Happier is closed are set up on the phone.',
    notificationsOff: 'No notifications',
    sampleNeedsYouTitle: 'Review #2481 needs you',
    sampleNeedsYouBody: 'The agent wants to run yarn test:e2e in ~/happier. Allow?',
    sampleReadyTitle: 'Fix flaky reconnect test is ready',
    sampleReadyBody: 'Found it: the retry timer was never cleared. It’s fixed and the test passes.',
    sampleStatusBody: 'Open Happier to see it.',
    sampleSessionReconnect: 'Fix flaky reconnect test',
    sampleSessionCraft: 'Craft pass lab',
    sampleSessionReview: 'Review #2481',
    sampleSessionPricing: 'Pricing page copy',
    sampleSessionDocs: 'Docs search index',
    sampleWorking: 'Working',
    sampleNeedsYou: 'Needs you',
    sampleReady: 'Ready to review',
    summaryTitle: 'Here’s your setup',
    summaryDescription: ({ changed }) => changed === 0
        ? 'Everything below is already saved. Nothing changed.'
        : changed === 1
            ? 'Everything below is already saved. One choice changed; the rest stayed as they were.'
            : `Everything below is already saved. ${changed} choices changed; the rest stayed as they were.`,
    summaryChange: 'Change',
    summaryFooter: 'You can change any of this later in Settings, or walk through it again from Settings → Appearance.',
    replayTitle: 'Personalize Happier',
    replaySubtitle: 'Six quick choices, each previewed live.',
    replayAction: 'Start',
    journeyHandoff: 'Make it yours',
};


export const personalizeTranslationsEnglish = { en } satisfies Pick<Readonly<Record<string, PersonalizeTranslation>>, "en">;
