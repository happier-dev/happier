

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
}>;


export const sessionRemotePermissionGrantTranslationsEnglish = { en: {
        title: 'Remote permission grants',
        entryTitle: 'Remote permission grants',
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
        listTitle: 'Session grants',
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
    } } as const satisfies Pick<Readonly<Record<string, SessionRemotePermissionGrantTranslations>>, "en">;