export function handleSocketReconnected(params: {
    log: { log: (message: string) => void }
    invalidateSessions: () => void
    invalidateMachines: () => void
    invalidateArtifacts: () => void
    invalidateFriends: () => void
    invalidateFriendRequests: () => void
    invalidateFeed: () => void
    getLoadedSessionIdsForMessages: () => string[]
    invalidateMessagesForSession: (sessionId: string) => void
    invalidateGitStatusForSession: (sessionId: string) => void
}) {
    const {
        log,
        invalidateSessions,
        invalidateMachines,
        invalidateArtifacts,
        invalidateFriends,
        invalidateFriendRequests,
        invalidateFeed,
        getLoadedSessionIdsForMessages,
        invalidateMessagesForSession,
        invalidateGitStatusForSession,
    } = params

    log.log('🔌 Socket reconnected')
    invalidateSessions()
    invalidateMachines()
    log.log('🔌 Socket reconnected: Invalidating artifacts sync')
    invalidateArtifacts()
    invalidateFriends()
    invalidateFriendRequests()
    invalidateFeed()

    // Prefer incremental message catch-up (afterSeq) only for sessions whose transcripts have been loaded.
    // Avoid triggering transcript fetches for every session in the list on each reconnect.
    for (const sessionId of getLoadedSessionIdsForMessages()) {
        invalidateMessagesForSession(sessionId)
        invalidateGitStatusForSession(sessionId)
    }
}

