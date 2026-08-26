import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { AgentState, Metadata, Session } from '@/api/types';
import { initializeBackendRunSession } from './initializeBackendRunSession';

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
  };
}

describe('initializeBackendRunSession pending first input', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('preserves non-daemon first-input ordering', async () => {
    vi.stubEnv('HAPPIER_DAEMON_PENDING_FIRST_INPUT', JSON.stringify({
      text: 'Commit me through Pending.',
      localId: 'spawn-first-turn:stable-nonce',
    }));
    const metadata = {} as Metadata;
    const state = { controlledByUser: false } as AgentState;
    const events: string[] = [];
    const session = {
      sessionId: 'new-session',
      enqueueSessionUserMessage: vi.fn(async () => {
        events.push('pending-committed');
      }),
    } as unknown as ApiSessionClient;

    await initializeBackendRunSession(
      {
        api: {
          getOrCreateSession: async () => createSessionResponse('new-session', metadata, state),
          sessionSyncClient: () => session,
        },
        sessionTag: 'tag-first-input',
        metadata,
        state,
        uiLogPrefix: '[Codex]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 1 },
        },
      },
      {
        primeAgentStateForUiFn: () => {},
        reportSessionToDaemonIfRunningFn: async () => {
          events.push('daemon-report');
        },
        persistTerminalAttachmentInfoIfNeededFn: async () => {},
        sendTerminalFallbackMessageIfNeededFn: () => {},
      },
    );

    expect(session.enqueueSessionUserMessage).toHaveBeenCalledExactlyOnceWith({
      text: 'Commit me through Pending.',
      localId: 'spawn-first-turn:stable-nonce',
      meta: { source: 'ui', sentFrom: 'cli' },
      inputAdmission: {
        provenance: { v: 1, kind: 'host', producer: 'agentRuntimeFirstInput' },
        request: {
          v: 1,
          producer: 'agentRuntimeFirstInput',
          caller: { kind: 'host' },
          permission: {},
        },
      },
    });
    expect(events).toEqual(['pending-committed', 'daemon-report']);
    expect(process.env.HAPPIER_DAEMON_PENDING_FIRST_INPUT).toBeUndefined();
  });

  it('waits for the required daemon ACK before first-input admission', async () => {
    vi.stubEnv('HAPPIER_DAEMON_PENDING_FIRST_INPUT', JSON.stringify({
      text: 'Admit only after canonical auth.',
      localId: 'spawn-first-turn:daemon',
    }));
    const metadata = { startedBy: 'daemon' } as Metadata;
    const state = { controlledByUser: false } as AgentState;
    const events: string[] = [];
    const session = {
      sessionId: 'canonical-session',
      enqueueSessionUserMessage: vi.fn(async () => {
        events.push('pending-committed');
      }),
    } as unknown as ApiSessionClient;
    const reportSessionToDaemonIfRunningFn = vi.fn(async () => {
      events.push('daemon-ack');
    });

    await initializeBackendRunSession(
      {
        api: {
          getOrCreateSession: async () => createSessionResponse(
            'canonical-session',
            metadata,
            state,
          ),
          sessionSyncClient: () => session,
        },
        sessionTag: 'tag-daemon-first-input',
        metadata,
        state,
        uiLogPrefix: '[Codex]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 1 },
        },
      },
      {
        primeAgentStateForUiFn: () => {
          events.push('ui-ready');
        },
        reportSessionToDaemonIfRunningFn,
        persistTerminalAttachmentInfoIfNeededFn: async () => {},
        sendTerminalFallbackMessageIfNeededFn: () => {},
      },
    );

    expect(reportSessionToDaemonIfRunningFn).toHaveBeenCalledWith({
      sessionId: 'canonical-session',
      metadata,
      requireDaemonAck: true,
    });
    expect(events).toEqual(['ui-ready', 'daemon-ack', 'pending-committed']);
    expect(process.env.HAPPIER_DAEMON_PENDING_FIRST_INPUT).toBeUndefined();
  });

  it('retains daemon-bridge first-input custody until runtime readiness without fallback', async () => {
    vi.stubEnv('HAPPIER_DAEMON_PENDING_FIRST_INPUT', JSON.stringify({
      text: 'Transform only after the daemon runtime opens.',
      localId: 'spawn-first-turn:daemon-runtime-ready',
    }));
    const metadata = { startedBy: 'daemon' } as Metadata;
    const state = { controlledByUser: false } as AgentState;
    const bridgeFailure = Object.assign(
      new Error('Agent runtime session bridge handle is unavailable'),
      { code: 'agent_runtime_daemon_bridge_failed' },
    );
    const session = {
      sessionId: 'canonical-session',
      enqueueSessionUserMessage: vi.fn(async () => {
        throw bridgeFailure;
      }),
    } as unknown as ApiSessionClient;

    const result = await initializeBackendRunSession(
      {
        api: {
          getOrCreateSession: async () => createSessionResponse(
            'canonical-session',
            metadata,
            state,
          ),
          sessionSyncClient: () => session,
        },
        sessionTag: 'tag-daemon-runtime-ready',
        metadata,
        state,
        uiLogPrefix: '[Codex]',
        deferPendingFirstInputCommitUntilRuntimeReady: true,
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 1 },
        },
      },
      {
        primeAgentStateForUiFn: () => {},
        reportSessionToDaemonIfRunningFn: async () => {},
        persistTerminalAttachmentInfoIfNeededFn: async () => {},
        sendTerminalFallbackMessageIfNeededFn: () => {},
      },
    );

    expect(session.enqueueSessionUserMessage).not.toHaveBeenCalled();
    expect(process.env.HAPPIER_DAEMON_PENDING_FIRST_INPUT).toBeDefined();
    const commit = result.commitPendingFirstInputAfterRuntimeReady;
    if (!commit) throw new Error('expected retained pending-first-input commit');
    await expect(commit()).rejects.toBe(bridgeFailure);
    expect(session.enqueueSessionUserMessage).toHaveBeenCalledOnce();
    expect(process.env.HAPPIER_DAEMON_PENDING_FIRST_INPUT).toBeDefined();
  });

  it('executes a retained pending-first-input commit exactly once', async () => {
    vi.stubEnv('HAPPIER_DAEMON_PENDING_FIRST_INPUT', JSON.stringify({
      text: 'Commit once after runtime readiness.',
      localId: 'spawn-first-turn:daemon-runtime-ready-once',
    }));
    const metadata = { startedBy: 'daemon' } as Metadata;
    const state = { controlledByUser: false } as AgentState;
    const session = {
      sessionId: 'canonical-session',
      enqueueSessionUserMessage: vi.fn(async () => undefined),
    } as unknown as ApiSessionClient;

    const result = await initializeBackendRunSession(
      {
        api: {
          getOrCreateSession: async () => createSessionResponse(
            'canonical-session',
            metadata,
            state,
          ),
          sessionSyncClient: () => session,
        },
        sessionTag: 'tag-daemon-runtime-ready-once',
        metadata,
        state,
        uiLogPrefix: '[Codex]',
        deferPendingFirstInputCommitUntilRuntimeReady: true,
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 1 },
        },
      },
      {
        primeAgentStateForUiFn: () => {},
        reportSessionToDaemonIfRunningFn: async () => {},
        persistTerminalAttachmentInfoIfNeededFn: async () => {},
        sendTerminalFallbackMessageIfNeededFn: () => {},
      },
    );

    const commit = result.commitPendingFirstInputAfterRuntimeReady;
    if (!commit) throw new Error('expected retained pending-first-input commit');
    await commit();
    await commit();

    expect(session.enqueueSessionUserMessage).toHaveBeenCalledExactlyOnceWith({
      text: 'Commit once after runtime readiness.',
      localId: 'spawn-first-turn:daemon-runtime-ready-once',
      meta: { source: 'ui', sentFrom: 'cli' },
      inputAdmission: {
        provenance: { v: 1, kind: 'host', producer: 'agentRuntimeFirstInput' },
        request: {
          v: 1,
          producer: 'agentRuntimeFirstInput',
          caller: { kind: 'host' },
          permission: {},
        },
      },
    });
    expect(process.env.HAPPIER_DAEMON_PENDING_FIRST_INPUT).toBeUndefined();
  });

  it('retains first-input custody when the required daemon ACK fails', async () => {
    vi.stubEnv('HAPPIER_DAEMON_PENDING_FIRST_INPUT', JSON.stringify({
      text: 'Keep until canonical auth exists.',
      localId: 'spawn-first-turn:daemon-ack-failure',
    }));
    const metadata = { startedBy: 'daemon' } as Metadata;
    const state = { controlledByUser: false } as AgentState;
    const primeAgentStateForUiFn = vi.fn();
    const session = {
      sessionId: 'canonical-session',
      enqueueSessionUserMessage: vi.fn(),
      close: vi.fn(async () => {}),
    } as unknown as ApiSessionClient;

    await expect(initializeBackendRunSession(
      {
        api: {
          getOrCreateSession: async () => createSessionResponse(
            'canonical-session',
            metadata,
            state,
          ),
          sessionSyncClient: () => session,
        },
        sessionTag: 'tag-daemon-ack-failure',
        metadata,
        state,
        uiLogPrefix: '[Codex]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 1 },
        },
      },
      {
        primeAgentStateForUiFn,
        reportSessionToDaemonIfRunningFn: async () => {
          throw new Error('daemon readiness failed');
        },
        persistTerminalAttachmentInfoIfNeededFn: async () => {},
        sendTerminalFallbackMessageIfNeededFn: () => {},
      },
    )).rejects.toThrow('daemon readiness failed');

    expect(primeAgentStateForUiFn).toHaveBeenCalledOnce();
    expect(session.enqueueSessionUserMessage).not.toHaveBeenCalled();
    expect(process.env.HAPPIER_DAEMON_PENDING_FIRST_INPUT).toBeDefined();
  });

  it('does not report an empty handoff or clear custody when Pending enqueue fails', async () => {
    vi.stubEnv('HAPPIER_DAEMON_PENDING_FIRST_INPUT', JSON.stringify({
      text: 'Keep custody on failure.',
      localId: 'spawn-first-turn:stable-failure',
    }));
    const metadata = {} as Metadata;
    const state = { controlledByUser: false } as AgentState;
    const reportSessionToDaemonIfRunningFn = vi.fn(async () => {});
    const session = {
      sessionId: 'new-session',
      enqueueSessionUserMessage: vi.fn(async () => {
        throw new Error('pending unavailable');
      }),
      close: vi.fn(async () => {}),
    } as unknown as ApiSessionClient;

    await expect(initializeBackendRunSession(
      {
        api: {
          getOrCreateSession: async () => createSessionResponse('new-session', metadata, state),
          sessionSyncClient: () => session,
        },
        sessionTag: 'tag-first-input-failure',
        metadata,
        state,
        uiLogPrefix: '[Codex]',
        startupMetadataOverrides: {
          permissionModeOverride: { mode: 'default', updatedAt: 1 },
        },
      },
      {
        primeAgentStateForUiFn: () => {},
        reportSessionToDaemonIfRunningFn,
        persistTerminalAttachmentInfoIfNeededFn: async () => {},
        sendTerminalFallbackMessageIfNeededFn: () => {},
      },
    )).rejects.toThrow('pending unavailable');

    expect(reportSessionToDaemonIfRunningFn).not.toHaveBeenCalled();
    expect(process.env.HAPPIER_DAEMON_PENDING_FIRST_INPUT).toBeDefined();
  });
});
