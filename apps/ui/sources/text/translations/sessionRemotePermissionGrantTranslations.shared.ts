

export type SessionRemotePermissionGrantTranslations = Readonly<{
    title: string;
    entryTitle: string;
    entrySubtitle: string;
    loadingTitle: string;
    loadingReason: string;
    emptyTitle: string;
    emptyReason: string;
    unavailableTitle: string;
    unavailableReason: string;
    ownerOnlyTitle: string;
    ownerOnlyReason: string;
    retry: string;
    listTitle: string;
    grantActive: (params: Readonly<{ actor: string }>) => string;
    grantRevoked: (params: Readonly<{ actor: string }>) => string;
    grantDetail: (params: Readonly<{
        grantId: string;
        sourceRef: string;
        sourceRevisionOrEpoch: string;
    }>) => string;
    revoke: string;
    revoking: string;
    revokeConfirmTitle: string;
    revokeConfirmBody: (params: Readonly<{ identifier: string }>) => string;
    revokeFailedTitle: string;
    revokeFailedReason: string;
    loadMore: string;
    loadingMore: string;
    loadMoreFailedReason: string;
    /** Session › Allowed: the Session's own "allow for this Session" Actions, and the sheet row that adds one. */
    consent: Readonly<{
        actionsTitle: string;
        actionsDescription: string;
        anywhere: string;
        onTarget: (params: Readonly<{ target: string }>) => string;
        addAction: string;
        noActionsToAdd: string;
        emptyTitle: string;
        emptyReason: string;
        loadingTitle: string;
        unavailableTitle: string;
        unavailableReason: string;
        saveFailed: string;
        nextTime: string;
        askAgain: string;
        always: string;
        askAgainDescription: (params: Readonly<{ agent: string }>) => string;
        alwaysDescription: (params: Readonly<{ agent: string; action: string }>) => string;
        onTargetDescription: (params: Readonly<{ agent: string; action: string; target: string }>) => string;
        approvedOnce: string;
        agentFallback: string;
    }>;
}>;


export const sessionRemotePermissionGrantTranslationsEnglish = { en: {
        title: 'Allowed',
        entryTitle: 'Allowed',
        entrySubtitle: 'Review and revoke session-scoped remote grants',
        loadingTitle: 'Loading remote permission grants',
        loadingReason: 'Checking the current session owner’s grants.',
        emptyTitle: 'No remote permission grants',
        emptyReason: 'This session has no remote grants to review.',
        unavailableTitle: 'Remote permission grants unavailable',
        unavailableReason: 'Check that this is the current session owner and that its machine is available, then try again.',
        ownerOnlyTitle: 'Only the session owner can manage remote grants',
        ownerOnlyReason: 'Shared participants can respond to eligible prompts, but cannot review or revoke the session owner’s grants.',
        retry: 'Retry',
        listTitle: 'Agent tool permissions',
        grantActive: ({ actor }) => `Active grant from ${actor}`,
        grantRevoked: ({ actor }) => `Revoked grant from ${actor}`,
        grantDetail: ({ grantId, sourceRef, sourceRevisionOrEpoch }) => `Grant ${grantId} · Source ${sourceRef} (${sourceRevisionOrEpoch})`,
        revoke: 'Revoke grant',
        revoking: 'Revoking…',
        revokeConfirmTitle: 'Revoke remote permission grant?',
        revokeConfirmBody: ({ identifier }) => `This immediately revokes the remote grant for ${identifier}.`,
        revokeFailedTitle: 'Could not update remote permission grants',
        revokeFailedReason: 'The grant may have changed or the owner machine may be unavailable. Try again.',
        loadMore: 'Load more grants',
        loadingMore: 'Loading more grants…',
        loadMoreFailedReason: 'More grants could not be loaded. Try again.',
        consent: {
            actionsTitle: 'Actions',
            actionsDescription: 'An Action here runs or asks in this Session, whatever your settings say. Default follows your settings.',
            anywhere: 'Anywhere',
            onTarget: ({ target }) => `On ${target}`,
            addAction: 'Add an Action',
            noActionsToAdd: 'Every Action already has its own choice here.',
            emptyTitle: 'No Actions allowed yet',
            emptyReason: 'Choose Always when an agent asks, or add an Action here.',
            loadingTitle: 'Loading allowed Actions',
            unavailableTitle: 'Allowed Actions unavailable',
            unavailableReason: 'Happier couldn’t read this Session’s choices, so every Action asks as usual.',
            saveFailed: 'Couldn’t save that change. Try again.',
            nextTime: 'Next time in this Session',
            askAgain: 'Ask again',
            always: 'Always',
            askAgainDescription: ({ agent }) => `${agent} asks again next time.`,
            alwaysDescription: ({ agent, action }) => `${agent} can run ${action} in this Session without asking. Change it in Session › Allowed.`,
            onTargetDescription: ({ agent, action, target }) => `${agent} can run ${action} on ${target} in this Session without asking. Change it in Session › Allowed.`,
            approvedOnce: 'Approved once. Couldn’t save it for this Session; you’ll be asked again.',
            agentFallback: 'The agent',
        },
    } } as const satisfies Pick<Readonly<Record<string, SessionRemotePermissionGrantTranslations>>, "en">;