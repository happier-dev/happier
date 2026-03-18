import { describe, expect, it, vi } from 'vitest'

import { initializeBackendRunSession } from '@/agent/runtime/initializeBackendRunSession'
import type { ApiSessionClient } from '@/api/session/sessionClient'
import type { AgentState, Metadata, Session } from '@/api/types'

function createSessionStub(overrides: Partial<ApiSessionClient> = {}): ApiSessionClient {
  return {
    ensureMetadataSnapshot: async () => ({} as Metadata),
    ...overrides,
  } as unknown as ApiSessionClient
}

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

describe('initializeBackendRunSession', () => {
  it('attaches to an existing session, applies startup metadata update, and runs startup side effects', async () => {
    const metadata = { terminal: { mode: 'tmux' } } as unknown as Metadata
    const state = { controlledByUser: false } as AgentState
    const session = createSessionStub({
      ensureMetadataSnapshot: async () => ({ path: '/tmp/project' } as unknown as Metadata),
    })

    const api = {
      getOrCreateSession: async () => null,
      sessionSyncClient: () => session,
    }

    const startupUpdates: Array<{ mode: 'attach' | 'start' | undefined }> = []
    const daemonReports: string[] = []
    const persisted: string[] = []
    let fallbackCount = 0
    let primedWithPrefix: string | null = null

    const result = await initializeBackendRunSession(
      {
        api,
        sessionTag: 'tag-1',
        metadata,
        state,
        existingSessionId: ' session-123 ',
        uiLogPrefix: '[Qwen]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 100 },
        },
      },
      {
        createBaseSessionForAttachFn: async () => createSessionResponse('session-123', metadata, state),
        applyStartupMetadataUpdateToSessionFn: async (opts) => {
          startupUpdates.push({ mode: opts.mode })
        },
        primeAgentStateForUiFn: (_session, logPrefix) => {
          primedWithPrefix = logPrefix
        },
        reportSessionToDaemonIfRunningFn: async (opts) => {
          daemonReports.push(opts.sessionId)
        },
        persistTerminalAttachmentInfoIfNeededFn: async (opts) => {
          persisted.push(opts.sessionId)
        },
        sendTerminalFallbackMessageIfNeededFn: () => {
          fallbackCount += 1
        },
      },
    )

    expect(result.attachedToExistingSession).toBe(true)
    expect(result.reportedSessionId).toBe('session-123')
    expect(result.session).toBe(session)
    expect(startupUpdates).toEqual([{ mode: 'attach' }])
    expect(daemonReports).toEqual(['session-123'])
    expect(persisted).toEqual(['session-123'])
    expect(fallbackCount).toBe(1)
    expect(primedWithPrefix).toBe('[Qwen]')
  })

  it('does not apply startup metadata update when attach snapshot is unavailable', async () => {
    const metadata = { terminal: { mode: 'tmux' } } as unknown as Metadata
    const state = { controlledByUser: false } as AgentState
    const session = createSessionStub({
      ensureMetadataSnapshot: async () => {
        throw new Error('unavailable')
      },
    })

    const api = {
      getOrCreateSession: async () => null,
      sessionSyncClient: () => session,
    }

    let applyStartupCalls = 0
    const attachSnapshotErrors: unknown[] = []
    const attachSnapshotMissing: Array<unknown | null> = []

    const result = await initializeBackendRunSession(
      {
        api,
        sessionTag: 'tag-2',
        metadata,
        state,
        existingSessionId: 'session-456',
        uiLogPrefix: '[Kilo]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 100 },
        },
        onAttachMetadataSnapshotError: (error) => {
          attachSnapshotErrors.push(error)
        },
        onAttachMetadataSnapshotMissing: (error) => {
          attachSnapshotMissing.push(error)
        },
      },
      {
        createBaseSessionForAttachFn: async () => createSessionResponse('session-456', metadata, state),
        applyStartupMetadataUpdateToSessionFn: async () => {
          applyStartupCalls += 1
        },
        primeAgentStateForUiFn: () => {},
        reportSessionToDaemonIfRunningFn: async () => {},
        persistTerminalAttachmentInfoIfNeededFn: async () => {},
        sendTerminalFallbackMessageIfNeededFn: () => {},
      },
    )

    expect(result.attachedToExistingSession).toBe(true)
    expect(applyStartupCalls).toBe(0)
    expect(attachSnapshotErrors).toHaveLength(1)
    expect(attachSnapshotMissing).toHaveLength(1)
  })

  it('reports merged authoritative attach metadata to the daemon for existing-session attaches', async () => {
    const metadata = {
      path: '/tmp/local-workspace',
      workspaceId: 'ws_local',
      workspaceLocationId: 'loc_local',
      workspaceCheckoutId: 'checkout_local',
      hostPid: 321,
      acpSessionModesV1: { v: 1, provider: 'codex' },
    } as unknown as Metadata
    const state = { controlledByUser: false } as AgentState
    const session = createSessionStub({
      ensureMetadataSnapshot: async () => ({
        path: '/srv/canonical-workspace',
        workspaceId: 'ws_authoritative',
        workspaceLocationId: 'loc_authoritative',
        workspaceCheckoutId: 'checkout_authoritative',
        permissionMode: 'ask',
        permissionModeUpdatedAt: 7,
      } as unknown as Metadata),
    })

    const api = {
      getOrCreateSession: async () => null,
      sessionSyncClient: () => session,
    }

    let reportedMetadata: Metadata | null = null

    await initializeBackendRunSession(
      {
        api,
        sessionTag: 'tag-attach-report-merged-metadata',
        metadata,
        state,
        existingSessionId: 'session-report-merged-metadata',
        uiLogPrefix: '[Codex]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 100 },
        },
        metadataKeysToUnsetOnAttach: ['acpSessionModesV1'],
      },
      {
        createBaseSessionForAttachFn: async () =>
          createSessionResponse('session-report-merged-metadata', metadata, state),
        applyStartupMetadataUpdateToSessionFn: async () => {},
        primeAgentStateForUiFn: () => {},
        reportSessionToDaemonIfRunningFn: async (opts) => {
          reportedMetadata = opts.metadata
        },
        persistTerminalAttachmentInfoIfNeededFn: async () => {},
        sendTerminalFallbackMessageIfNeededFn: () => {},
      },
    )

    expect(reportedMetadata).toMatchObject({
      path: '/srv/canonical-workspace',
      hostPid: 321,
      permissionMode: 'default',
      permissionModeUpdatedAt: 100,
      lifecycleState: 'running',
    })
    expect((reportedMetadata as Record<string, unknown> | null)?.workspaceId).toBeUndefined()
    expect((reportedMetadata as Record<string, unknown> | null)?.workspaceLocationId).toBeUndefined()
    expect((reportedMetadata as Record<string, unknown> | null)?.workspaceCheckoutId).toBeUndefined()
    expect((reportedMetadata as any)?.acpSessionModesV1).toBeUndefined()
  })

  it('reports runtime machine identity to the daemon for handoff attaches', async () => {
    const metadata = {
      path: '/srv/target-workspace',
      host: 'target-host',
      homeDir: '/Users/target',
      happyHomeDir: '/Users/target/.happier',
      machineId: 'machine_target',
      hostPid: 654,
    } as unknown as Metadata
    const state = { controlledByUser: false } as AgentState
    const session = createSessionStub({
      ensureMetadataSnapshot: async () => ({
        path: '/srv/source-workspace',
        host: 'source-host',
        homeDir: '/Users/source',
        happyHomeDir: '/Users/source/.happier',
        machineId: 'machine_source',
      } as unknown as Metadata),
    })

    const api = {
      getOrCreateSession: async () => null,
      sessionSyncClient: () => session,
    }

    let reportedMetadata: Metadata | null = null

    await initializeBackendRunSession(
      {
        api,
        sessionTag: 'tag-attach-report-runtime-identity',
        metadata,
        state,
        existingSessionId: 'session-report-runtime-identity',
        uiLogPrefix: '[Claude]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 100 },
        },
        attachMetadataIdentityPolicy: 'replace_with_runtime_identity',
      },
      {
        createBaseSessionForAttachFn: async () =>
          createSessionResponse('session-report-runtime-identity', metadata, state),
        applyStartupMetadataUpdateToSessionFn: async () => {},
        primeAgentStateForUiFn: () => {},
        reportSessionToDaemonIfRunningFn: async (opts) => {
          reportedMetadata = opts.metadata
        },
        persistTerminalAttachmentInfoIfNeededFn: async () => {},
        sendTerminalFallbackMessageIfNeededFn: () => {},
      },
    )

    expect(reportedMetadata).toMatchObject({
      path: '/srv/target-workspace',
      host: 'target-host',
      homeDir: '/Users/target',
      happyHomeDir: '/Users/target/.happier',
      machineId: 'machine_target',
      hostPid: 654,
      lifecycleState: 'running',
    })
  })

  it('awaits async attach metadata callbacks before running startup side effects', async () => {
    const metadata = { terminal: { mode: 'tmux' } } as unknown as Metadata
    const state = { controlledByUser: false } as AgentState
    const events: string[] = []
    const session = createSessionStub({
      ensureMetadataSnapshot: async () => ({ path: '/tmp/project' } as unknown as Metadata),
    })

    const api = {
      getOrCreateSession: async () => null,
      sessionSyncClient: () => session,
    }

    await initializeBackendRunSession(
      {
        api,
        sessionTag: 'tag-attach-await',
        metadata,
        state,
        existingSessionId: 'session-await',
        uiLogPrefix: '[Codex]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 100 },
        },
        onAttachMetadataSnapshotReady: async () => {
          events.push('attach-callback-start')
          await Promise.resolve()
          events.push('attach-callback-end')
        },
      },
      {
        createBaseSessionForAttachFn: async () => createSessionResponse('session-await', metadata, state),
        applyStartupMetadataUpdateToSessionFn: async () => {
          events.push('startup-update')
        },
        primeAgentStateForUiFn: () => {
          events.push('prime-agent-state')
        },
        reportSessionToDaemonIfRunningFn: async () => {
          events.push('report-session')
        },
        persistTerminalAttachmentInfoIfNeededFn: async () => {
          events.push('persist-terminal')
        },
        sendTerminalFallbackMessageIfNeededFn: () => {
          events.push('send-fallback')
        },
      },
    )

    expect(events).toEqual([
      'startup-update',
      'attach-callback-start',
      'attach-callback-end',
      'prime-agent-state',
      'report-session',
      'persist-terminal',
      'send-fallback',
    ])
  })

  it('awaits async attach startup metadata updates before attach callbacks and side effects', async () => {
    const metadata = { terminal: { mode: 'tmux' } } as unknown as Metadata
    const state = { controlledByUser: false } as AgentState
    const events: string[] = []
    const session = createSessionStub({
      ensureMetadataSnapshot: async () => ({ path: '/tmp/project' } as unknown as Metadata),
    })

    const api = {
      getOrCreateSession: async () => null,
      sessionSyncClient: () => session,
    }

    await initializeBackendRunSession(
      {
        api,
        sessionTag: 'tag-attach-startup-await',
        metadata,
        state,
        existingSessionId: 'session-startup-await',
        uiLogPrefix: '[Codex]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 100 },
        },
        onAttachMetadataSnapshotReady: () => {
          events.push('attach-callback')
        },
      },
      {
        createBaseSessionForAttachFn: async () => createSessionResponse('session-startup-await', metadata, state),
        applyStartupMetadataUpdateToSessionFn: async () => {
          events.push('startup-update-start')
          await Promise.resolve()
          events.push('startup-update-end')
        },
        primeAgentStateForUiFn: () => {
          events.push('prime-agent-state')
        },
        reportSessionToDaemonIfRunningFn: async () => {
          events.push('report-session')
        },
        persistTerminalAttachmentInfoIfNeededFn: async () => {
          events.push('persist-terminal')
        },
        sendTerminalFallbackMessageIfNeededFn: () => {
          events.push('send-fallback')
        },
      },
    )

    expect(events).toEqual([
      'startup-update-start',
      'startup-update-end',
      'attach-callback',
      'prime-agent-state',
      'report-session',
      'persist-terminal',
      'send-fallback',
    ])
  })

  it('creates a new session and reports daemon startup side effects', async () => {
    const metadata = { terminal: { mode: 'tmux' } } as unknown as Metadata
    const state = { controlledByUser: false } as AgentState
    const initialSession = createSessionStub()
    const swappedSession = createSessionStub()

    const api = {
      getOrCreateSession: async () => createSessionResponse('new-session', metadata, state),
      sessionSyncClient: () => initialSession,
    }

    const daemonReports: string[] = []
    const persisted: string[] = []
    let fallbackCount = 0
    let onSessionSwapCount = 0

    const result = await initializeBackendRunSession(
      {
        api,
        sessionTag: 'tag-3',
        metadata,
        state,
        uiLogPrefix: '[OpenCode]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 100 },
        },
        onSessionSwap: (newSession) => {
          if (newSession === swappedSession) {
            onSessionSwapCount += 1
          }
        },
      },
      {
        setupOfflineReconnectionFn: () => {
          onSessionSwapCount += 0
          return {
            session: initialSession,
            reconnectionHandle: null,
            isOffline: false,
          }
        },
        primeAgentStateForUiFn: () => {},
        reportSessionToDaemonIfRunningFn: async (opts) => {
          daemonReports.push(opts.sessionId)
        },
        persistTerminalAttachmentInfoIfNeededFn: async (opts) => {
          persisted.push(opts.sessionId)
        },
        sendTerminalFallbackMessageIfNeededFn: () => {
          fallbackCount += 1
        },
      },
    )

    expect(result.attachedToExistingSession).toBe(false)
    expect(result.reportedSessionId).toBe('new-session')
    expect(result.session).toBe(initialSession)
    expect(daemonReports).toEqual(['new-session'])
    expect(persisted).toEqual(['new-session'])
    expect(fallbackCount).toBe(1)
    expect(onSessionSwapCount).toBe(0)

    // Ensure callback wiring remains available for runtime reconnection swaps.
    const setupResult = await initializeBackendRunSession(
      {
        api,
        sessionTag: 'tag-4',
        metadata,
        state,
        uiLogPrefix: '[OpenCode]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 100 },
        },
        onSessionSwap: (newSession) => {
          if (newSession === swappedSession) {
            onSessionSwapCount += 1
          }
        },
      },
      {
        setupOfflineReconnectionFn: (opts) => {
          opts.onSessionSwap(swappedSession)
          return {
            session: initialSession,
            reconnectionHandle: null,
            isOffline: false,
          }
        },
        primeAgentStateForUiFn: () => {},
        reportSessionToDaemonIfRunningFn: async () => {},
        persistTerminalAttachmentInfoIfNeededFn: async () => {},
        sendTerminalFallbackMessageIfNeededFn: () => {},
      },
    )

    expect(setupResult.session).toBe(initialSession)
    expect(onSessionSwapCount).toBe(1)
  })

  it('throws when a new session cannot be created and offline stubs are not allowed', async () => {
    const metadata = {} as Metadata
    const state = { controlledByUser: false } as AgentState
    const api = {
      getOrCreateSession: async () => null,
      sessionSyncClient: () => createSessionStub(),
    }

    await expect(
      initializeBackendRunSession({
        api,
        sessionTag: 'tag-5',
        metadata,
        state,
        uiLogPrefix: '[Kimi]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 100 },
        },
      }),
    ).rejects.toThrow('Failed to create session')
  })

  it('applies startup side effects in persist-first order when requested', async () => {
    const metadata = { terminal: { mode: 'tmux' } } as unknown as Metadata
    const state = { controlledByUser: false } as AgentState
    const session = createSessionStub({
      ensureMetadataSnapshot: async () => ({ path: '/tmp/project' } as unknown as Metadata),
    })

    const api = {
      getOrCreateSession: async () => null,
      sessionSyncClient: () => session,
    }

    const events: string[] = []

    await initializeBackendRunSession(
      {
        api,
        sessionTag: 'tag-6',
        metadata,
        state,
        existingSessionId: 'session-order',
        uiLogPrefix: '[Gemini]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 100 },
        },
        startupSideEffectsOrder: 'persist-first',
      },
      {
        createBaseSessionForAttachFn: async () => createSessionResponse('session-order', metadata, state),
        applyStartupMetadataUpdateToSessionFn: async () => {},
        primeAgentStateForUiFn: () => {},
        persistTerminalAttachmentInfoIfNeededFn: async () => {
          events.push('persist')
        },
        sendTerminalFallbackMessageIfNeededFn: () => {
          events.push('fallback')
        },
        reportSessionToDaemonIfRunningFn: async () => {
          events.push('report')
        },
      },
    )

    expect(events).toEqual(['persist', 'fallback', 'report'])
  })

  it('does not block existing-session attach completion on daemon report retries', async () => {
    const metadata = { terminal: { mode: 'tmux' }, startedBy: 'terminal' } as unknown as Metadata
    const state = { controlledByUser: false } as AgentState
    const session = createSessionStub({
      ensureMetadataSnapshot: async () => ({ path: '/tmp/project' } as unknown as Metadata),
    })

    const api = {
      getOrCreateSession: async () => null,
      sessionSyncClient: () => session,
    }

    const events: string[] = []
    let releaseDaemonReport!: () => void
    const daemonReportBlocked = new Promise<void>((resolve) => {
      releaseDaemonReport = resolve
    })
    let daemonReportFinishedResolve!: () => void
    const daemonReportFinished = new Promise<void>((resolve) => {
      daemonReportFinishedResolve = resolve
    })

    let settled = false

    const initializePromise = initializeBackendRunSession(
      {
        api,
        sessionTag: 'tag-attach-daemon-report',
        metadata,
        state,
        existingSessionId: 'session-attach-daemon-report',
        uiLogPrefix: '[Codex]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 100 },
        },
        startupSideEffectsOrder: 'persist-first',
      },
      {
        createBaseSessionForAttachFn: async () =>
          createSessionResponse('session-attach-daemon-report', metadata, state),
        applyStartupMetadataUpdateToSessionFn: async () => {},
        primeAgentStateForUiFn: () => {},
        persistTerminalAttachmentInfoIfNeededFn: async () => {
          events.push('persist')
        },
        sendTerminalFallbackMessageIfNeededFn: () => {
          events.push('fallback')
        },
        reportSessionToDaemonIfRunningFn: async () => {
          events.push('report-start')
          await daemonReportBlocked
          events.push('report-end')
          daemonReportFinishedResolve()
        },
      },
    ).then((result) => {
      settled = true
      events.push('initialized')
      return result
    })

    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    expect(settled).toBe(true)
    expect(events).toEqual(['persist', 'fallback', 'report-start', 'initialized'])

    releaseDaemonReport()
    await daemonReportFinished
    await initializePromise

    expect(events).toEqual(['persist', 'fallback', 'report-start', 'initialized', 'report-end'])
  })

  it('runs startup side effects after offline reconnection swaps in a real session', async () => {
    const metadata = { terminal: { mode: 'tmux' }, startedBy: 'terminal' } as unknown as Metadata
    const state = { controlledByUser: false } as AgentState
    const offlineSession = createSessionStub({ sessionId: 'offline-tag' })
    const realSession = createSessionStub({ sessionId: 'real-session' })

    const api = {
      getOrCreateSession: async () => null,
      sessionSyncClient: () => offlineSession,
    }

    const daemonReports: string[] = []
    const persisted: string[] = []
    let fallbackCount = 0
    const primed: string[] = []
    let capturedSwap: ((next: ApiSessionClient) => void) | undefined
    let userOnSwapCount = 0

    const result = await initializeBackendRunSession(
      {
        api,
        sessionTag: 'tag-offline',
        metadata,
        state,
        uiLogPrefix: '[Codex]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 100 },
        },
        allowOfflineStub: true,
        onSessionSwap: async () => {
          userOnSwapCount += 1
          throw new Error('user onSessionSwap failed')
        },
      },
      {
        setupOfflineReconnectionFn: (opts) => {
          capturedSwap = opts.onSessionSwap
          return {
            session: offlineSession,
            reconnectionHandle: { cancel: () => {}, getSession: () => null, isReconnected: () => false },
            isOffline: true,
          }
        },
        primeAgentStateForUiFn: (session) => {
          primed.push(session.sessionId)
        },
        reportSessionToDaemonIfRunningFn: async (opts) => {
          daemonReports.push(opts.sessionId)
        },
        persistTerminalAttachmentInfoIfNeededFn: async (opts) => {
          persisted.push(opts.sessionId)
        },
        sendTerminalFallbackMessageIfNeededFn: () => {
          fallbackCount += 1
        },
      },
    )

    expect(result.attachedToExistingSession).toBe(false)
    expect(result.reportedSessionId).toBeNull()
    expect(result.session).toBe(offlineSession)
    expect(primed).toEqual(['offline-tag'])
    expect(daemonReports).toEqual([])
    expect(persisted).toEqual([])
    expect(fallbackCount).toBe(0)

    if (typeof capturedSwap !== 'function') {
      throw new Error('Expected setupOfflineReconnection to provide an onSessionSwap callback')
    }

    const onUnhandled = vi.fn()
    process.on('unhandledRejection', onUnhandled)
    try {
      capturedSwap(realSession)

      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(onUnhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }

    expect(userOnSwapCount).toBe(1)
    expect(primed).toEqual(['offline-tag', 'real-session'])
    expect(daemonReports).toEqual(['real-session'])
    expect(persisted).toEqual(['real-session'])
    expect(fallbackCount).toBe(1)
  })

  it('passes offline notify messages through setupOfflineReconnection when provided', async () => {
    const metadata = { startedBy: 'terminal' } as unknown as Metadata
    const state = { controlledByUser: false } as AgentState
    const offlineSession = createSessionStub({ sessionId: 'offline-tag' })

    const api = {
      getOrCreateSession: async () => null,
      sessionSyncClient: () => offlineSession,
    }

    const notifications: string[] = []

    await initializeBackendRunSession(
      {
        api,
        sessionTag: 'tag-offline-notify',
        metadata,
        state,
        uiLogPrefix: '[Codex]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 100 },
        },
        allowOfflineStub: true,
        offlineNotify: (message: string) => notifications.push(message),
      },
      {
        setupOfflineReconnectionFn: (opts) => {
          opts.onNotify?.('hello')
          return {
            session: offlineSession,
            reconnectionHandle: { cancel: () => {}, getSession: () => null, isReconnected: () => false },
            isOffline: true,
          }
        },
        primeAgentStateForUiFn: () => {},
        reportSessionToDaemonIfRunningFn: async () => {},
        persistTerminalAttachmentInfoIfNeededFn: async () => {},
        sendTerminalFallbackMessageIfNeededFn: () => {},
      },
    )

    expect(notifications).toEqual(['hello'])
  })
})
