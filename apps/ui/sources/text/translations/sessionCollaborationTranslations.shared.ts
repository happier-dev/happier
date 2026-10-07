import { sessionCollaborationPaneTranslationsEnglish as sessionCollaborationPaneTranslations } from './sessionCollaborationPaneTranslations.shared';



export const en = {
    pane: sessionCollaborationPaneTranslations.en,
    title: 'Collaboration', viewingNow: 'Viewing now', justYou: 'Just you', typing: 'Typing…',
    stale: 'May be out of date', unavailable: 'Live presence unavailable', connecting: 'Connecting…',
    unnamed: 'Happier member', open: 'Open Collaboration', conversations: 'Conversations',     accessUnavailable: 'Session access unavailable',
    accessUnavailableReason: 'This Home doesn’t support sharing Sessions with people.',
        discussion: {
        title: 'Conversations', newDiscussion: 'New conversation', create: 'Create conversation',
        titlePlaceholder: 'Conversation title', messagePlaceholder: 'Write a message…',
        active: 'Active', activeDisclosure: 'Show active conversations', archived: 'Archived', archivedDisclosure: 'Show archived conversations',
        emptyActive: 'No active conversations yet.', emptyArchived: 'No archived conversations.',
        loading: 'Loading conversations…', loadError: 'Conversations could not be loaded.', retry: 'Try again', checking: 'Checking for updates…', deliveryUnknown: 'Delivery unknown — check before retrying.',
        locked: 'You can read this conversation, but you cannot post to it.', offline: 'You’re offline. Reconnect to continue.', unavailable: 'This conversation is unavailable.',
        featureUnavailable: 'Conversations are not enabled on this Home.',
        bindingUnavailable: 'Sign in to this Home again to see conversations.',
        scopeMismatch: 'These conversations belong to a different account on this Home.',
        modeMismatch: 'This conversation content does not match the Session’s encryption mode. Try again, or ask a Session manager to check access.',
        unreadCount: ({ count }: { count: number }) => count === 1 ? '1 unread' : `${count.toLocaleString()} unread`,
        unreadMentionCount: ({ count }: { count: number }) => count === 1 ? '1 unread mention' : `${count.toLocaleString()} unread mentions`,
        mentioned: 'You were mentioned', unreadConversations: 'Unread conversations',
        messageCount: ({ count }: { count: number }) => count === 1 ? '1 message' : `${count.toLocaleString()} messages`,
        viaAgent: 'Via Agent', collaborator: 'Collaborator', contentUnavailable: 'Message unavailable',
        rename: 'Rename conversation', archive: 'Archive conversation', restore: 'Restore conversation',
        selection: { copy: 'Copy', askAgent: 'Ask Agent', sendToSession: 'Send to Session', handoffError: 'The selected messages could not be added to the Session composer.' },
        titleRequired: 'Add a title to start this conversation.', encryptedTitle: 'Encrypted conversation', archivedNotice: 'This conversation is archived.', sessionArchived: 'This Session is archived.', postDenied: 'You can no longer post in this Session.', invalidMention: 'Someone you mentioned can no longer read this Session.', invalidContent: 'This message can’t be sent as written. It may be empty or too long.', idempotencyConflict: 'A different message was already sent under this identity.', sendFailed: 'This message could not be sent.', dismiss: 'Dismiss', loadOlder: 'Load older messages', loadMore: 'Load more conversations',
    },
};


export const sessionCollaborationTranslationsEnglish: Pick<Record<'en'|'ca'|'de'|'es'|'fr'|'it'|'ja'|'pl'|'pt'|'ru'|'zh-Hans'|'zh-Hant', typeof en>, "en"> = { en };