import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSpawnedSession,
  sendSessionMessage,
  createCliApprovalsArtifactStore,
  emitSessionLifecycleHookEvent,
  resolveSessionTransportContext,
  executeExecutionRunAction,
  callSessionRpc,
  hostSubagentStore,
} = vi.hoisted(() => ({
  createSpawnedSession: vi.fn(),
  sendSessionMessage: vi.fn(),
  createCliApprovalsArtifactStore: vi.fn(() => ({})),
  emitSessionLifecycleHookEvent: vi.fn(),
  resolveSessionTransportContext: vi.fn(),
  executeExecutionRunAction: vi.fn(),
  callSessionRpc: vi.fn(),
  hostSubagentStore: {
    list: vi.fn(),
    get: vi.fn(),
    watch: vi.fn(),
    upsert: vi.fn(),
    updateStatus: vi.fn(),
    complete: vi.fn(),
  },
}));

vi.mock('@/session/services/createSpawnedSession', () => ({
  createSpawnedSession,
}));

vi.mock('@/session/services/sendSessionMessage', () => ({
  sendSessionMessage,
}));

vi.mock('@/session/actions/approvals/artifactStore', () => ({
  createCliApprovalsArtifactStore,
}));

vi.mock('@/session/services/resolveSessionTransportContext', () => ({
  resolveSessionTransportContext,
}));

vi.mock('@/session/services/executionRuns', async () => {
  const actual = await vi.importActual<any>('@/session/services/executionRuns');
  return {
    ...actual,
    executeExecutionRunAction,
  };
});

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc,
}));

vi.mock('@/session/subagents/hostSubagentStore', async () => {
  const actual = await vi.importActual<any>('@/session/subagents/hostSubagentStore');
  return {
    ...actual,
    hostSubagentStore,
  };
});

vi.mock('@/agent/runtime/bridges/session/SessionHostBridge', () => ({
  getSessionHostBridge: () => ({
    emitLifecycleHookEvent: emitSessionLifecycleHookEvent,
  }),
}));

import { createCliActionDeps } from './createCliActionDeps';

describe('createCliActionDeps hook dispatch', () => {
  beforeEach(() => {
    createSpawnedSession.mockReset();
    sendSessionMessage.mockReset();
    createCliApprovalsArtifactStore.mockReset();
    emitSessionLifecycleHookEvent.mockReset();
    resolveSessionTransportContext.mockReset();
    executeExecutionRunAction.mockReset();
    callSessionRpc.mockReset();
    hostSubagentStore.list.mockReset();
    hostSubagentStore.get.mockReset();
    hostSubagentStore.watch.mockReset();
    hostSubagentStore.upsert.mockReset();
    hostSubagentStore.updateStatus.mockReset();
    hostSubagentStore.complete.mockReset();
  });

  it('dispatches a session.spawn_new hook event after a successful spawn', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-new',
      session: { id: 'sess-new' },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'machine-1',
        path: '/repo',
        host: 'localhost',
        metadata: {
          workspaceId: 'workspace-1',
        },
      },
      happyHomeDir: '/tmp/happier-home',
    });

    await expect(deps.sessionSpawnNew({
      path: '/repo',
      backendTargetKey: 'agent:claude',
      title: 'My title',
      tag: 'tag-1',
      initialMessage: 'Hello from spawn',
      modelId: 'gpt-4o',
    })).resolves.toEqual({
      type: 'success',
      sessionId: 'sess-new',
      created: true,
      session: { id: 'sess-new' },
    });

    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ token: 'token' }),
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: {
        kind: 'backend',
        backendId: 'claude',
        sourceKind: 'built_in',
      },
      tag: 'tag-1',
      title: 'My title',
      initialMessage: 'Hello from spawn',
      modelId: 'gpt-4o',
    }));
    expect(emitSessionLifecycleHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      happyHomeDir: '/tmp/happier-home',
      eventId: 'session.spawn_new',
      happySessionId: 'sess-new',
      machineId: 'machine-1',
      cwd: '/repo',
      workspaceId: 'workspace-1',
      backendTarget: 'agent:claude',
      payload: expect.objectContaining({
        sessionId: 'sess-new',
        backendTargetKey: 'agent:claude',
        path: '/repo',
        title: 'My title',
        tag: 'tag-1',
        modelId: 'gpt-4o',
        initialMessageLength: 16,
      }),
    }));
  });

  it('spawns canonical plugin backendTargetKey values when the runtime carrier is explicit', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-plugin',
      session: { id: 'sess-plugin' },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'machine-1',
        path: '/repo',
      },
    });

    await expect(deps.sessionSpawnNew({
      agentId: 'claude',
      backendTargetKey: 'backend:plugin-review-bot',
      path: '/repo',
    })).resolves.toEqual({
      type: 'success',
      sessionId: 'sess-plugin',
      created: true,
      session: { id: 'sess-plugin' },
    });

    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: {
        kind: 'backend',
        backendId: 'plugin-review-bot',
        sourceKind: 'built_in',
      },
    }));
  });

  it('fails closed when legacy customAcp is used without an explicit concrete backend target', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'machine-1',
        path: '/repo',
      },
    });

    await expect(deps.sessionSpawnNew({
      agentId: 'customAcp',
      path: '/repo',
    })).resolves.toEqual({
      type: 'error',
      errorCode: 'invalid_parameters',
      errorMessage: 'invalid_parameters',
    });

    expect(createSpawnedSession).not.toHaveBeenCalled();
  });

  it('dispatches a session.message.send hook event after a successful send', async () => {
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      localId: 'local-1',
      waited: false,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'machine-1',
        path: '/repo',
        metadata: {
          workspaceId: 'workspace-1',
        },
      },
      happyHomeDir: '/tmp/happier-home',
    });

    await expect(deps.sessionSendMessage({
      sessionId: 'sess-1',
      message: 'Hello world',
      wait: true,
      timeoutSeconds: 30,
      permissionModeOverride: 'read_only',
      modelOverride: 'gpt-4o',
    })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-1',
      localId: 'local-1',
      waited: false,
    });

    expect(sendSessionMessage).toHaveBeenCalledWith({
      credentials: expect.objectContaining({ token: 'token' }),
      idOrPrefix: 'sess-1',
      message: 'Hello world',
      wait: true,
      timeoutMs: 30000,
      permissionModeOverride: 'read_only',
      modelOverride: 'gpt-4o',
    });
    expect(emitSessionLifecycleHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      happyHomeDir: '/tmp/happier-home',
      eventId: 'session.message.send',
      happySessionId: 'sess-1',
      machineId: 'machine-1',
      cwd: '/repo',
      workspaceId: 'workspace-1',
      payload: expect.objectContaining({
        sessionId: 'sess-1',
        messageLength: 11,
        wait: true,
        timeoutSeconds: 30,
        permissionModeOverride: 'read_only',
        modelOverride: 'gpt-4o',
      }),
    }));
  });

  it('dispatches session.message.send hooks with the resolved canonical session id when invoked by prefix', async () => {
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      localId: 'local-1',
      waited: false,
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'machine-1',
        path: '/repo',
      },
      happyHomeDir: '/tmp/happier-home',
    });

    await expect(deps.sessionSendMessage({
      sessionId: 'sess',
      message: 'Hello world',
      wait: false,
      timeoutSeconds: 15,
    })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-1',
      localId: 'local-1',
      waited: false,
    });

    expect(sendSessionMessage).toHaveBeenCalledWith({
      credentials: expect.objectContaining({ token: 'token' }),
      idOrPrefix: 'sess',
      message: 'Hello world',
      wait: false,
      timeoutMs: 15000,
    });
    expect(emitSessionLifecycleHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      happyHomeDir: '/tmp/happier-home',
      eventId: 'session.message.send',
      happySessionId: 'sess-1',
      payload: expect.objectContaining({
        sessionId: 'sess-1',
        messageLength: 11,
        wait: false,
        timeoutSeconds: 15,
      }),
    }));
  });

  it('routes execution-run parent-session permission responses through session permission RPC', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        metadata: {},
        agentState: {
          requests: {
            'perm-1': {
              tool: 'Write',
              arguments: {
                executionRun: {
                  responseTarget: {
                    kind: 'execution_run_host_bridge',
                    sessionId: 'sess-1',
                    runId: 'run-1',
                    callId: 'call-1',
                    sidechainId: 'sidechain-1',
                    backendId: 'opencode',
                    runtimeKind: 'server',
                    providerRequestId: 'perm-1',
                  },
                },
              },
            },
          },
        },
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });
    executeExecutionRunAction.mockResolvedValue({ ok: true });
    callSessionRpc.mockResolvedValue({ ok: true });

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        metadata: {},
      },
    });
    const sessionPermissionRespond = deps.sessionPermissionRespond;
    expect(sessionPermissionRespond).toBeTypeOf('function');

    await expect(sessionPermissionRespond!({
      sessionId: 'sess-1',
      decision: 'allow',
      requestId: 'perm-1',
    })).resolves.toEqual({ ok: true });

    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess-1',
      method: 'sess-1:session.permission.respond',
      request: { id: 'perm-1', approved: true },
    }));
    expect(executeExecutionRunAction).not.toHaveBeenCalled();
  });

  it('registers subagent watches through the bounded host watcher and returns the initial snapshot', async () => {
    const subagents = Object.freeze([
      {
        id: 'subagent-1',
        parentSessionId: 'sess-1',
        origin: 'plugin',
        kind: 'custom',
        status: 'running',
        createdAt: 1,
      },
    ]);
    const unsubscribe = vi.fn();
    hostSubagentStore.watch.mockImplementation((_args, onEvent) => {
      onEvent(Object.freeze({ kind: 'snapshot', subagents }));
      return Object.freeze({ unsubscribe });
    });

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-1',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        metadata: {},
      },
    });

    await expect(deps.subagentsWatch?.({
      parentSessionId: 'sess-1',
      id: 'subagent-1',
    })).resolves.toEqual({
      kind: 'snapshot',
      subagents,
    });

    expect(hostSubagentStore.watch).toHaveBeenCalledWith({
      parentSessionId: 'sess-1',
      id: 'subagent-1',
    }, expect.any(Function));
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(hostSubagentStore.list).not.toHaveBeenCalled();
  });
});
