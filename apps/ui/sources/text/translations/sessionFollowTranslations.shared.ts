

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
        "externalAttachedOnly": "Background sync is off, so updates may arrive only while this session is attached."
    },
    "level": {
        "none": "No notifications",
        "important": "Important updates",
        "all_messages": "Every new message"
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
        "title": "Session updates",
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
        "includeNextTurn": "Include updates with the destination's next turn.",
        "sourceKeyPreparing": "Preparing encrypted access…",
        "sourceKeyWaiting": "Waiting for encrypted access.",
        "sourceKeyUnavailable": "This computer can't provide encrypted access.",
        "sourceSessionKeyUnavailable": "This session's encrypted access is not available here.",
        "catchUpPending": "Catch-up pending"
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