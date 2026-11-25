

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
    holdToTalkNeedsConversation?: string;
    holdToTalkUnavailableHere?: string;
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
    newConversation: string;
    continueConversation: string;
    /** The ended glance's visible word beside its plus; `newConversation` stays the accessible name. */
    newConversationShort: string;
    /** Under a waiting request in the Voice section: how it can be answered (spoken approval on or off). */
    needsYouHint: Readonly<{ spoken: string; tap: string }>;
    endedCaption: (params: Readonly<{ elapsed: string }>) => string;
    dismiss: string;
    mute: string;
    unmute: string;
    end: string;
    /** The transport's Send while the call waits on it: send what you said now. */
    sendNow: string;
    captions: Readonly<{ connecting: string; listening: string; listeningSend: string; transcribing: string; thinking: string; thinkingInputUnavailable: string; speaking: string; interrupted: string; muted: string; reconnecting: string; blocked: string; failed: string; needsYou: string }>;
    /** The transport's short recovery verbs; the full recovery label stays the accessible name. */
    recovery: Readonly<{ allow: string; setUp: string }>;
    /** Read-aloud (Say) outside a conversation: its status word and Stop. */
    readAloud: Readonly<{ preparing: string; speaking: string; stop: string }>;
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
        holdToTalkNeedsConversation: "Start a conversation to check whether Hold is available. Tapping still starts Voice.",
        holdToTalkUnavailableHere: "Hold is unavailable in this conversation. Tap to talk instead.",
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
        newConversation: 'New conversation',
        continueConversation: 'Continue',
        newConversationShort: "New",
        needsYouHint: { spoken: "Read aloud · say yes or no, or tap", tap: "Read aloud · tap to decide" },
        endedCaption: ({ elapsed }) => `${elapsed} · the conversation is saved`,
        dismiss: 'Dismiss',
        mute: "Mute",
        unmute: "Unmute",
        end: "End",
        sendNow: "Send now",
        captions: { thinkingInputUnavailable: "Wait for the reply before sending more.", connecting: "Opening the audio channel", listening: "Go ahead", listeningSend: "Talk, then press Send", transcribing: "Turning that into text", thinking: "Working out an answer", speaking: "You can interrupt any time", interrupted: "Go ahead", muted: "Voice can still speak", reconnecting: "Connection lost · trying again", blocked: "Allow microphone access to talk", failed: "Try again, or check Voice settings", needsYou: "Waiting for your decision" },
        recovery: { allow: "Allow", setUp: "Set up" },
        readAloud: { preparing: "Getting ready to read", speaking: "Reading aloud", stop: "Stop reading" },
        containerA11y: ({ status }) => `Voice, ${status}`,
    } } satisfies Pick<Readonly<Record<string, VoicePresenceTranslation>>, "en">;
