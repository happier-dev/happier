

export type VoicePresenceTranslation = Readonly<{
    welcomeText: string;
    customVoice: string;
    boundWelcomeText: (params: Readonly<{ name: string }>) => string;
    greetingLiteralUnavailable: string;
    title: string;
    howYouTalk: string;
    holdToTalkTitle: string;
    holdToTalkDescription: string;
    holdToTalkHint: string;
    holdToTalkUnavailable: (params: Readonly<{ service: string }>) => string;
    talkWithVoice: string;
    dictate: string;
    globalVoice: string;
    interrupt: string;
    options: string;
    you: string;
    showConversation: string;
    dragToMove: string;
    openConversation: string;
    settings: string;
    ended: string;
    /** Status word while the microphone is muted (Voice can still speak). */
    muted: string;
    /** The rest mic's action while Voice is not set up yet. */
    setUp: string;
    setUpHint: string;
    startAgain: string;
    endedCaption: (params: Readonly<{ elapsed: string }>) => string;
    dismiss: string;
    mute: string;
    unmute: string;
    end: string;
    captions: Readonly<{ connecting: string; listening: string; transcribing: string; thinking: string; speaking: string; interrupted: string; muted: string; reconnecting: string; blocked: string; failed: string }>;
    /** The transport's short recovery verbs; the full recovery label stays the accessible name. */
    recovery: Readonly<{ allow: string; setUp: string }>;
    containerA11y: (params: Readonly<{ status: string }>) => string;
}>;


export const voicePresenceTranslationsEnglish = { en: {
        welcomeText: "Hi, I'm listening — what would you like to do?",
        customVoice: 'Custom voice',
        boundWelcomeText: ({ name }) => `Hi, you're talking to ${name} — what would you like to do?`,
        greetingLiteralUnavailable: "For this Reply in language, the service waits until you speak.",
        title: 'Voice',
        howYouTalk: "How you talk",
        holdToTalkTitle: "Hold to talk",
        holdToTalkDescription: "Hold the Voice mark to say one thing; let go to send. Tapping still starts and ends Voice.",
        holdToTalkHint: "Hold for one turn; release to send. Drag away to cancel.",
        holdToTalkUnavailable: ({ service }) => `${service} doesn't support holding to talk. Tap to talk instead.`,
        talkWithVoice: 'Talk with Voice',
        dictate: 'Dictate',
        globalVoice: 'Global Voice',
        interrupt: 'Interrupt',
        options: 'Voice options',
        you: 'You',
        showConversation: 'Show the conversation',
        dragToMove: 'Drag to move',
        openConversation: 'Open the conversation',
        settings: 'Voice settings',
        ended: 'Voice ended',
        muted: 'Muted',
        setUp: 'Set up Voice',
        setUpHint: 'Opens Voice settings to choose how Voice talks',
        startAgain: 'Start again',
        endedCaption: ({ elapsed }) => `${elapsed} · the conversation is saved`,
        dismiss: 'Dismiss',
        mute: "Mute",
        unmute: "Unmute",
        end: "End",
        captions: { connecting: "Opening the audio channel", listening: "Go ahead", transcribing: "Turning that into text", thinking: "Working out an answer", speaking: "You can interrupt any time", interrupted: "Go ahead", muted: "Unmute to talk · Voice can still speak", reconnecting: "Lost the connection · trying again", blocked: "Allow microphone access to talk", failed: "Try again, or check Voice settings" },
        recovery: { allow: "Allow", setUp: "Set up" },
        containerA11y: ({ status }) => `Voice, ${status}`,
    } } satisfies Pick<Readonly<Record<string, VoicePresenceTranslation>>, "en">;
