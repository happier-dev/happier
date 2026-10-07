

export const en = {
    sectionTitle: 'Drafts',
    sectionTitleForHome: ({ home }: { home: string }) => `Drafts on ${home}`,
    // A waiting Temporary-computer request is not an ordinary draft: its
    // package is already on someone else's computer. This title says exactly
    // which Home owns the live request, so switching Homes never makes one
    // silently disappear.
    waitingSectionTitleForHome: ({ home }: { home: string }) => `Waiting for a computer on ${home}`,
    badge: 'Draft',
    untitled: 'Untitled draft',
    continueEditing: 'Continue editing',
    startAnother: 'Start another',
    // Run-start outcome states for the interactive Agent-conversation draft. An unknown outcome
    // is never presented as a failure: it may already have started, so a second Start is a
    // deliberate, informed choice.
    executionRunStart: {
        starting: 'Starting the agent conversation…',
        reconciling: 'Checking whether this agent conversation started…',
        unresolved: 'We couldn’t confirm whether this agent conversation started. Starting another may create a second conversation.',
        targetChanged: 'The computer for this session changed before the conversation could start. Nothing was started.',
        secretReferenceOverlayUpdateRequired: 'Using shared secrets in an agent conversation needs an updated computer. Nothing was started.',
    },
    status: {
        offline: 'Offline — saved on this device',
        syncing: 'Syncing…',
        conflict: 'Needs review',
        // The Home cannot serve this draft address at all, so it is kept on
        // this device permanently rather than waiting for a reconnect.
        unsupported: 'Not synced — this Home can’t sync this draft',
        startInterrupted: 'Start interrupted',
    },
    availability: {
        machineUnavailable: 'Machine unavailable',
        pluginUnavailable: 'Plugin unavailable',
        attachmentNeedsAttention: 'Attachment needs attention',
    },
    new: { action: 'New session' },
    delete: {
        action: 'Delete draft',
        confirmTitle: 'Delete this draft?',
        confirmDescription: 'This removes the draft from your synced devices.',
    },
    conflict: {
        title: 'Review conflicting changes',
        description: 'Choose which version to keep for each field. You can copy your device version before replacing it.',
        mine: 'This device',
        synced: 'Synced version',
        useSynced: 'Use synced',
        keepDevice: 'Keep this device',
        copyMine: 'Copy mine',
        copied: 'Copied',
        copyFailed: 'Could not copy this value.',
        field: {
            text: 'Message',
            mentions: 'Mentions',
            attachments: 'Attachments',
            recipient: 'Recipient',
            agentContinuation: 'Agent continuation',
            executionRunRequestedAction: 'Run delivery',
        },
    },
};


export const sessionDraftTranslationsEnglish = { en };