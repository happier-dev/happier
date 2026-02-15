export function handleSocketReconnected(params: {
    log: { log: (message: string) => void }
    invalidateSessions: () => void
    invalidateMachines: () => void
    invalidateArtifacts: () => void
    invalidateFriends: () => void
    invalidateFriendRequests: () => void
    invalidateFeed: () => void
    invalidateAutomations: () => void
    getLoadedSessionIdsForMessages: () => string[]
    invalidateMessagesForSession: (sessionId: string) => void
    invalidateScmStatusForSession: (sessionId: string) => void
}) {
    const {
        log,
        invalidateSessions,
        invalidateMachines,
        invalidateArtifacts,
        invalidateFriends,
        invalidateFriendRequests,
        invalidateFeed,
        invalidateAutomations,
        getLoadedSessionIdsForMessages,
        invalidateMessagesForSession,
        invalidateScmStatusForSession,
    } = params

    log.log('🔌 Socket reconnected')
    invalidateSessions()
    invalidateMachines()
    log.log('🔌 Socket reconnected: Invalidating artifacts sync')
    invalidateArtifacts()
    invalidateFriends()
    invalidateFriendRequests()
    invalidateFeed()
    invalidateAutomations()

    // Prefer incremental message catch-up (afterSeq) only for sessions whose transcripts have been loaded.
    // Avoid triggering transcript fetches for every session in the list on each reconnect.
    for (const sessionId of getLoadedSessionIdsForMessages()) {
        invalidateMessagesForSession(sessionId)
        invalidateScmStatusForSession(sessionId)
    }
}
