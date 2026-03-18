import { afterEach, describe, expect, it, vi } from 'vitest'

import axios from 'axios'

import type { ApiClient } from '@/api/api'
import { connectionState } from '@/api/offline/serverConnectionErrors'
import { setupOfflineReconnection } from '@/api/offline/setupOfflineReconnection'
import type { ApiSessionClient } from '@/api/session/sessionClient'
import type { AgentState, Metadata, Session } from '@/api/types'

function createSessionResponse(id: string, metadata: Metadata, state: AgentState): Session {
  return {
    id,
    seq: 0,
    encryptionMode: 'e2ee',
    encryptionKey: new Uint8Array([1]),
    encryptionVariant: 'legacy',
    metadata,
    metadataVersion: 0,
    agentState: state,
    agentStateVersion: 0,
  }
}

describe('setupOfflineReconnection', () => {
  afterEach(() => {
    connectionState.reset()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('does not emit unhandledRejection when onSessionSwap returns a rejected promise', async () => {
    vi.useFakeTimers()
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200 } as any)

    const metadata = { startedBy: 'terminal' } as unknown as Metadata
    const state = { controlledByUser: false } as AgentState
    const realSession = { sessionId: 'real-session' } as unknown as ApiSessionClient

    const api = {
      getOrCreateSession: async () => createSessionResponse('real-session', metadata, state),
      sessionSyncClient: () => realSession,
    } as unknown as ApiClient

    let onSessionSwapCalls = 0
    const onSessionSwap = () => {
      onSessionSwapCalls += 1
      return Promise.reject(new Error('onSessionSwap failed'))
    }

    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)
    try {
      const result = setupOfflineReconnection({
        api,
        sessionTag: 'tag-offline',
        metadata,
        state,
        response: null,
        onNotify: () => {},
        onSessionSwap,
      })

      expect(result.isOffline).toBe(true)
      expect(result.reconnectionHandle).not.toBeNull()

      await vi.advanceTimersByTimeAsync(5_000)
      await vi.runAllTimersAsync()

      // Give Node a chance to surface an unhandled rejection if one was created.
      vi.useRealTimers()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      expect(onSessionSwapCalls).toBe(1)
      expect(onUnhandled).not.toHaveBeenCalled()
      } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('recovers shared offline UX state after a successful session swap', async () => {
    vi.useFakeTimers()
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200 } as any)

    const metadata = { startedBy: 'terminal' } as unknown as Metadata
    const state = { controlledByUser: false } as AgentState
    const realSession = { sessionId: 'real-session' } as unknown as ApiSessionClient

    const api = {
      getOrCreateSession: async () => createSessionResponse('real-session', metadata, state),
      sessionSyncClient: () => realSession,
    } as unknown as ApiClient

    connectionState.fail({ operation: 'Session creation', errorCode: 'ECONNREFUSED' })
    expect(connectionState.isOffline()).toBe(true)

    const result = setupOfflineReconnection({
      api,
      sessionTag: 'tag-offline',
      metadata,
      state,
      response: null,
      onNotify: () => {},
      onSessionSwap: () => {},
    })

    expect(result.isOffline).toBe(true)
    expect(result.reconnectionHandle).not.toBeNull()

    await vi.advanceTimersByTimeAsync(5_000)
    await vi.runAllTimersAsync()

    expect(connectionState.isOffline()).toBe(false)
  })
})
