import { describe, expect, it, vi } from 'vitest'

import { handleSocketReconnected } from './socketReconnect'

describe('handleSocketReconnected', () => {
    it('invalidates messages only for sessions with loaded transcripts', () => {
        const log = { log: vi.fn() }

        const invalidateSessions = vi.fn()
        const invalidateMachines = vi.fn()
        const invalidateArtifacts = vi.fn()
        const invalidateFriends = vi.fn()
        const invalidateFriendRequests = vi.fn()
        const invalidateFeed = vi.fn()

        const invalidateMessagesForSession = vi.fn()
        const invalidateGitStatusForSession = vi.fn()

        handleSocketReconnected({
            log,
            invalidateSessions,
            invalidateMachines,
            invalidateArtifacts,
            invalidateFriends,
            invalidateFriendRequests,
            invalidateFeed,
            getLoadedSessionIdsForMessages: () => ['s1', 's2'],
            invalidateMessagesForSession,
            invalidateGitStatusForSession,
        })

        expect(invalidateSessions).toHaveBeenCalledTimes(1)
        expect(invalidateMachines).toHaveBeenCalledTimes(1)
        expect(invalidateArtifacts).toHaveBeenCalledTimes(1)
        expect(invalidateFriends).toHaveBeenCalledTimes(1)
        expect(invalidateFriendRequests).toHaveBeenCalledTimes(1)
        expect(invalidateFeed).toHaveBeenCalledTimes(1)

        expect(invalidateMessagesForSession).toHaveBeenCalledTimes(2)
        expect(invalidateMessagesForSession).toHaveBeenCalledWith('s1')
        expect(invalidateMessagesForSession).toHaveBeenCalledWith('s2')

        expect(invalidateGitStatusForSession).toHaveBeenCalledTimes(2)
        expect(invalidateGitStatusForSession).toHaveBeenCalledWith('s1')
        expect(invalidateGitStatusForSession).toHaveBeenCalledWith('s2')
    })

    it('does not invalidate per-session messages when no loaded session ids exist', () => {
        const log = { log: vi.fn() }

        const invalidateSessions = vi.fn()
        const invalidateMachines = vi.fn()
        const invalidateArtifacts = vi.fn()
        const invalidateFriends = vi.fn()
        const invalidateFriendRequests = vi.fn()
        const invalidateFeed = vi.fn()

        const invalidateMessagesForSession = vi.fn()
        const invalidateGitStatusForSession = vi.fn()

        handleSocketReconnected({
            log,
            invalidateSessions,
            invalidateMachines,
            invalidateArtifacts,
            invalidateFriends,
            invalidateFriendRequests,
            invalidateFeed,
            getLoadedSessionIdsForMessages: () => [],
            invalidateMessagesForSession,
            invalidateGitStatusForSession,
        })

        expect(invalidateSessions).toHaveBeenCalledTimes(1)
        expect(invalidateMachines).toHaveBeenCalledTimes(1)
        expect(invalidateArtifacts).toHaveBeenCalledTimes(1)
        expect(invalidateFriends).toHaveBeenCalledTimes(1)
        expect(invalidateFriendRequests).toHaveBeenCalledTimes(1)
        expect(invalidateFeed).toHaveBeenCalledTimes(1)
        expect(invalidateMessagesForSession).not.toHaveBeenCalled()
        expect(invalidateGitStatusForSession).not.toHaveBeenCalled()
    })

    it('applies per-session invalidation for each loaded id entry including duplicates', () => {
        const invalidateMessagesForSession = vi.fn()
        const invalidateGitStatusForSession = vi.fn()

        handleSocketReconnected({
            log: { log: vi.fn() },
            invalidateSessions: vi.fn(),
            invalidateMachines: vi.fn(),
            invalidateArtifacts: vi.fn(),
            invalidateFriends: vi.fn(),
            invalidateFriendRequests: vi.fn(),
            invalidateFeed: vi.fn(),
            getLoadedSessionIdsForMessages: () => ['s1', 's1', 's2'],
            invalidateMessagesForSession,
            invalidateGitStatusForSession,
        })

        expect(invalidateMessagesForSession).toHaveBeenCalledTimes(3)
        expect(invalidateMessagesForSession).toHaveBeenNthCalledWith(1, 's1')
        expect(invalidateMessagesForSession).toHaveBeenNthCalledWith(2, 's1')
        expect(invalidateMessagesForSession).toHaveBeenNthCalledWith(3, 's2')
        expect(invalidateGitStatusForSession).toHaveBeenCalledTimes(3)
        expect(invalidateGitStatusForSession).toHaveBeenNthCalledWith(1, 's1')
        expect(invalidateGitStatusForSession).toHaveBeenNthCalledWith(2, 's1')
        expect(invalidateGitStatusForSession).toHaveBeenNthCalledWith(3, 's2')
    })
})
