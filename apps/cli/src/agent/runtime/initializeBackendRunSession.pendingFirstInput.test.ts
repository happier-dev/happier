import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { AgentState, Metadata, Session } from '@/api/types';
import { initializeBackendRunSession } from './initializeBackendRunSession';
import { runAddedHostedSession } from './lifecycle/hostedSessionScope';
import { HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY, serializePendingFirstInputForEnv } from '@/daemon/spawn/pendingFirstInput';

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

  it('delivers and clears only the initializing hosted Session handoff after deferred readiness', async () => {
    const hostInput = serializePendingFirstInputForEnv({
      text: 'Host process input', localId: 'spawn-first-turn:host',
    });
    vi.stubEnv(HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY, hostInput);
    const inputs = ['a', 'b'].map(id => ({
      text: `Session ${id} first input`, localId: `spawn-first-turn:${id}`,
    }));
    const environments = inputs.map(input => ({
      [HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]: serializePendingFirstInputForEnv(input),
    }));
    const delivered: Parameters<ApiSessionClient['enqueueSessionUserMessage']>[0][][] = [[], []];
    const initialized = await Promise.all(environments.map((environment, index) =>
      runAddedHostedSession({ environment, workingDirectory: '/repo', end: () => undefined }, async () => {
        await Promise.resolve();
        const metadata = { startedBy: 'daemon' } as Metadata;
        const state = { controlledByUser: false } as AgentState;
        // Session persistence and daemon IPC are the external boundaries;
        // initialization and first-input admission remain real.
        const session = {
          sessionId: `hosted-${index}`,
          enqueueSessionUserMessage: async (message: Parameters<ApiSessionClient['enqueueSessionUserMessage']>[0]) => {
            delivered[index].push(message);
          },
        } as unknown as ApiSessionClient;
        return initializeBackendRunSession({
          api: {
            getOrCreateSession: async () => createSessionResponse(session.sessionId, metadata, state),
            sessionSyncClient: () => session,
          },
          sessionTag: `hosted-first-input-${index}`,
          metadata, state, uiLogPrefix: '[hosted first input]',
          deferPendingFirstInputCommitUntilRuntimeReady: true,
          startupMetadataOverrides: { permissionModeOverride: { mode: 'default', updatedAt: 1 } },
        }, {
          reportSessionToDaemonIfRunningFn: async () => undefined,
          persistTerminalAttachmentInfoIfNeededFn: async () => undefined,
          sendTerminalFallbackMessageIfNeededFn: () => undefined,
        });
      })));

    expect(delivered).toEqual([[], []]);
    const commitB = initialized[1].commitPendingFirstInputAfterRuntimeReady;
    const commitA = initialized[0].commitPendingFirstInputAfterRuntimeReady;
    if (!commitA || !commitB) throw new Error('Expected both retained first-input commits');
    // Readiness may run after the initialization scope returns. The committer
    // must keep the environment that supplied its input.
    await commitB();
    expect(delivered[1]).toEqual([expect.objectContaining(inputs[1])]);
    expect(delivered[0]).toEqual([]);
    expect(environments[1][HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]).toBeUndefined();
    expect(environments[0][HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]).toBeDefined();
    expect(process.env[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]).toBe(hostInput);
    await commitA();
    expect(delivered[0]).toEqual([expect.objectContaining(inputs[0])]);
    expect(environments[0][HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]).toBeUndefined();
    expect(process.env[HAPPIER_DAEMON_PENDING_FIRST_INPUT_ENV_KEY]).toBe(hostInput);
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
      requestedAction: { v: 1, kind: 'send_now' },
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

  it('durably admits first input before the daemon can acknowledge spawn success', async () => {
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
    expect(events).toEqual(['pending-committed', 'daemon-ack']);
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

    const reportSessionToDaemonIfRunningFn = vi.fn(async () => {});
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
        reportSessionToDaemonIfRunningFn,
        persistTerminalAttachmentInfoIfNeededFn: async () => {},
        sendTerminalFallbackMessageIfNeededFn: () => {},
      },
    );

    expect(session.enqueueSessionUserMessage).not.toHaveBeenCalled();
    expect(reportSessionToDaemonIfRunningFn).not.toHaveBeenCalled();
    expect(process.env.HAPPIER_DAEMON_PENDING_FIRST_INPUT).toBeDefined();
    const commit = result.commitPendingFirstInputAfterRuntimeReady;
    if (!commit) throw new Error('expected retained pending-first-input commit');
    await expect(commit()).rejects.toBe(bridgeFailure);
    expect(session.enqueueSessionUserMessage).toHaveBeenCalledOnce();
    expect(reportSessionToDaemonIfRunningFn).not.toHaveBeenCalled();
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
    const reportSessionToDaemonIfRunningFn = vi.fn(async () => undefined);

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
        reportSessionToDaemonIfRunningFn,
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
      requestedAction: { v: 1, kind: 'send_now' },
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
    expect(reportSessionToDaemonIfRunningFn).toHaveBeenCalledOnce();
    expect(process.env.HAPPIER_DAEMON_PENDING_FIRST_INPUT).toBeUndefined();
  });

  it('keeps durable first-input admission when the later daemon ACK fails', async () => {
    vi.stubEnv('HAPPIER_DAEMON_PENDING_FIRST_INPUT', JSON.stringify({
      text: 'Keep until canonical auth exists.',
      localId: 'spawn-first-turn:daemon-ack-failure',
    }));
    const metadata = { startedBy: 'daemon' } as Metadata;
    const state = { controlledByUser: false } as AgentState;
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
        reportSessionToDaemonIfRunningFn: async () => {
          throw new Error('daemon readiness failed');
        },
        persistTerminalAttachmentInfoIfNeededFn: async () => {},
        sendTerminalFallbackMessageIfNeededFn: () => {},
      },
    )).rejects.toThrow('daemon readiness failed');

    expect(session.enqueueSessionUserMessage).toHaveBeenCalledOnce();
    expect(process.env.HAPPIER_DAEMON_PENDING_FIRST_INPUT).toBeUndefined();
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
        reportSessionToDaemonIfRunningFn,
        persistTerminalAttachmentInfoIfNeededFn: async () => {},
        sendTerminalFallbackMessageIfNeededFn: () => {},
      },
    )).rejects.toThrow('pending unavailable');

    expect(reportSessionToDaemonIfRunningFn).not.toHaveBeenCalled();
    expect(process.env.HAPPIER_DAEMON_PENDING_FIRST_INPUT).toBeDefined();
  });
});
