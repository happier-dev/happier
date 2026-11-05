

export type SessionFollowTranslations = typeof en;



export const en = {
    "notificationBody": {"message":"New message in this session.","failed":"The turn failed.","cancelled":"The turn was cancelled.","sourceUnavailable":"This session's source is unavailable."},
    "follow": "Follow",
    "unfollow": "Unfollow",
    "following": "Following",
    "notifications": "Notifications",
    "unavailableTitle": "Following is not available",
    "unavailableDescription": "This Home does not offer session following.",
    "unreachableTitle": "Couldn't reach this Home",
    "unreachableDescription": "Happier could not check whether this Home offers session following. Retry when it is reachable.",
    "editor": {
        "title": "Follow this session",
        "subtitle": "Get the updates that matter to you.",
        "ownerSubtitle": "You own this session, so its updates always reach you.",
        "externalAttachedOnly": "Background sync is off, so updates may arrive only while this session is attached.",
            "panelTitle": "Get updates from this session",
            "panelSubtitle": "Updates reach you as notifications or wait in your Inbox.",
            "suppressed": "Updates are off. You still own it.",
            "turnOff": "Turn off updates",
            "alsoFollow": ({ facts, count }: { facts: string; count: number }) => `${facts} ${count === 1 ? "also follows it" : "also follow it"}`,
            "people": "People",
            "quietHours": ({ range }: { range: string }) => `Quiet hours ${range} · nothing pushes; it still lands in Inbox`,
            "quietHoursOn": "Quiet hours are on · nothing pushes; it still lands in Inbox",
            "notFollowing": "You don’t follow it yet. Follow it to hear when it needs you."
    },
    "level": {
        "none": "No notifications",
        "important": "Important updates",
        "all_messages": "Every new message"
    },
    "policyEditor": {
        "presetLabel": "How much you hear",
        "presetDescription": {
            "everything": "Interrupts you whenever something happens.",
            "important": "Interrupts you only when it needs you, fails or stalls.",
            "quiet": "Nothing interrupts you. Updates wait quietly in Inbox.",
            "custom": "Choose how each event reaches you."
        },
        "customTitle": "Each event",
        "delivery": {
            "off": "Off",
            "quiet": "Inbox",
            "interrupt": "Push"
        },
        "session": {
            "presetLabel": "How much it hears",
            "presetDescription": {
                "everything": "Wakes it whenever something happens.",
                "important": "Wakes it only when something needs it, fails or stalls.",
                "quiet": "Nothing wakes it. Updates wait for its next turn.",
                "custom": "Choose how each event reaches it."
            },
            "delivery": { "interrupt": "Wake", "quiet": "Next turn" }
        },
        "events": {
            "needsYou": "Needs you",
            "decision": "Needs a decision",
            "approval": "Needs approval",
            "blocked": "Blocked",
            "finished": "Finished",
            "failedOrStopped": "Failed or stopped",
            "stalled": "Stalled",
            "updatePosted": "Update posted",
            "personWrote": "A person wrote in it",
            "goalChanged": "Goal changed",
            "message": "Every message"
        },
        "eventDescriptions": {
            "needsYou": "A decision, an approval, or it’s blocked",
            "failedOrStopped": "Also when a run ends without a word",
            "personWrote": "A notice and a link, never their words"
        }
    },
    "policy": {
        "everything": "Everything",
        "important": "Important",
        "quiet": "Quiet",
        "custom": "Custom"
    },
    "voice": {
        "title": "Include in Voice",
        "subtitle": "Voice can keep this session in context.",
        "waitingRuntime": "Waiting for the Voice runtime to connect.",
        "unsupported": "This runtime does not support including followed sessions in Voice.",
        "providerWithheld": "This Voice mode cannot include stored Session updates.",
        "waitingEncrypted": "Unlock this session to include it in Voice.",
        "initialSnapshotPending": "On your next Voice turn, include a brief current snapshot."
    },
    "once": { "title": "Notify me once", "subtitle": "On top of your level, then it ends.", "off": "Off", "turn": "When this turn ends", "attention": "When it next needs you" },
    "footer": "Following never changes who can access this session.",
    "settingsLink": "Notification settings…",
    "assignedExplanation": "Following because you were assigned",
    "assignedNotice": "A session was assigned to you.",
    "sharedNotice": "A session was shared with you.",
    "wakeEventExplanation": "Followed context changed, so Happier woke this Agent with the update.",
    "accessLost": "You no longer have access to this session.",
    "offline": "You're offline. Reconnect to change following.",
    "archived": "Following is paused while this session is archived.",
    "sources": {
        "title": "Following",
        "waitingRuntime": "Waiting for the destination Session to reconnect.",
        "unsupported": "Update or reconnect the CLI on the destination machine to receive updates.",
        "pausedArchived": "Updates are paused while the source or destination is archived.",
        "add": "Follow in another session…",
        "addSource": "Send updates from another session…",
        "chooseDestinationTitle": "Follow in another session",
        "chooseSourceTitle": "Send updates from another session",
        "row": ({ title }: { title: string }) => `Updates from “${title}”`,
        "nextTurn": "Next turn",
        "wakeOnHumanChange": "Wake when a person adds a message",
        "stop": "Stop updates",
        "stopForSource": ({ title }: { title: string }) => `Stop updates from “${title}”`,
        "panelSubtitle": "How much it hears",
        "includeNextTurn": "Include updates with the destination's next turn.",
        "empty": "Sessions it follows appear here",
        "sourceKeyPreparing": "Preparing encrypted access…",
        "sourceKeyWaiting": "Waiting for encrypted access.",
        "sourceKeyUnavailable": "This computer can't provide encrypted access.",
        "sourceSessionKeyUnavailable": "This session's encrypted access is not available here.",
        "catchUpPending": "Catch-up pending",
        "kindDiscussion": "Discussion",
        "kindWorkflowRun": "Workflow run",
        "executionRun": ({ title }: { title: string }) => `A run in “${title}”`,
        "sourceUnavailable": "No longer available",
        "followsThis": ({ title }: { title: string }) => `${title} follows this`,
        "ruleMatching": ({ facts }: { facts: string }) => `Sessions matching ${facts}`,
        "ruleEvery": "Every session it can see",
        "managerOnly": "It hears about this session as its manager. Change that in its coordinator setup.",
        "ruleWhich": "Which sessions",
        "ruleLeftOut": ({ name }: { name: string }) => `Skips project ${name}`,
        "ruleIncludeAgain": "Include again",
        "ruleIncludedAgain": ({ name }: { name: string }) => `Follows project ${name} again`
    },
    "preferences": {
        "title": "Automatically follow",
        "assigned": "Sessions assigned to me",
        "direct": "Sessions shared directly",
        "team": "Sessions shared through Teams",
        "group": "Sessions shared through Groups",
        "help": "Applies to new assignments and newly accessible sessions. Existing choices stay unchanged."
    }
};


export const sessionFollowTranslationsEnglish: Pick<Record<
    'en' | 'ca' | 'de' | 'es' | 'fr' | 'it' | 'ja' | 'pl' | 'pt' | 'ru' | 'zh-Hans' | 'zh-Hant',
    SessionFollowTranslations
>, "en"> = { en };
