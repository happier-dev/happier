import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY } from '@happier-dev/protocol';

const {
  createSpawnedSession,
  sendSessionMessage,
  createCliApprovalsArtifactStore,
  emitSessionLifecycleHookEvent,
  resolveSessionTransportContext,
  executeExecutionRunAction,
  callSessionRpc,
  hostSubagentStore,
  routeSessionGoalControl,
  routeSessionCatalogControl,
  routeSessionUsageLimitRecoveryCheckNow,
  routeSessionUsageLimitRecoverySwitchAccountNow,
  routeSessionUsageLimitRecoveryWaitResumeCancel,
  routeSessionUsageLimitRecoveryWaitResumeEnable,
  readSettings,
} = vi.hoisted(() => ({
  createSpawnedSession: vi.fn(),
  sendSessionMessage: vi.fn(),
  createCliApprovalsArtifactStore: vi.fn(() => ({})),
  emitSessionLifecycleHookEvent: vi.fn(),
  resolveSessionTransportContext: vi.fn(),
  executeExecutionRunAction: vi.fn(),
  callSessionRpc: vi.fn(),
  routeSessionGoalControl: vi.fn(),
  routeSessionCatalogControl: vi.fn(),
  routeSessionUsageLimitRecoveryCheckNow: vi.fn(),
  routeSessionUsageLimitRecoverySwitchAccountNow: vi.fn(),
  routeSessionUsageLimitRecoveryWaitResumeCancel: vi.fn(),
  routeSessionUsageLimitRecoveryWaitResumeEnable: vi.fn(),
  readSettings: vi.fn(),
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

vi.mock('@/session/goalControls/sessionGoalControlRouter', () => ({
  routeSessionGoalControl,
}));

vi.mock('@/session/catalogControls/sessionCatalogControlRouter', () => ({
  routeSessionCatalogControl,
}));

vi.mock('@/session/usageLimitRecoveryControls/sessionUsageLimitRecoveryControlRouter', () => ({
  routeSessionUsageLimitRecoveryCheckNow,
  routeSessionUsageLimitRecoveryWaitResumeCancel,
  routeSessionUsageLimitRecoveryWaitResumeEnable,
}));

vi.mock('@/session/usageLimitRecoveryControls/sessionUsageLimitRecoverySwitchAccountNow', () => ({
  routeSessionUsageLimitRecoverySwitchAccountNow,
}));

vi.mock('@/persistence', async () => {
  const actual = await vi.importActual<any>('@/persistence');
  return {
    ...actual,
    readSettings,
  };
});

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
    routeSessionGoalControl.mockReset();
    routeSessionCatalogControl.mockReset();
    routeSessionUsageLimitRecoveryCheckNow.mockReset();
    routeSessionUsageLimitRecoverySwitchAccountNow.mockReset();
    routeSessionUsageLimitRecoveryWaitResumeCancel.mockReset();
    routeSessionUsageLimitRecoveryWaitResumeEnable.mockReset();
    readSettings.mockReset();
    readSettings.mockResolvedValue({ machineId: 'local-machine' });
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

  it('fails explicit completed permission request ids locally instead of acknowledging stale responses', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        metadata: {},
        agentState: {
          requests: {},
          completedRequests: {
            'perm-done': {
              kind: 'permission',
              tool: 'Bash',
              status: 'approved',
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

    await expect(deps.sessionPermissionRespond?.({
      sessionId: 'sess-1',
      decision: 'allow',
      requestId: 'perm-done',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      errorMessage: 'permission_request_not_found',
      sessionId: 'sess-1',
    });

    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('fails explicit completed user-action request ids locally instead of acknowledging stale answers', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      rawSession: {
        metadata: {},
        agentState: {
          requests: {},
          completedRequests: {
            'question-done': {
              kind: 'user_action',
              tool: 'AskUserQuestion',
              status: 'approved',
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

    await expect(deps.sessionUserActionAnswer?.({
      sessionId: 'sess-1',
      requestId: 'question-done',
      answers: [{ question: 'Continue?', answer: 'Yes' }],
    })).resolves.toEqual({
      ok: false,
      errorCode: 'permission_request_not_found',
      errorMessage: 'permission_request_not_found',
      sessionId: 'sess-1',
    });

    expect(callSessionRpc).not.toHaveBeenCalled();
  });

  it('routes inactive session goal controls with the local machine id from settings', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-remote',
      rawSession: {
        id: 'sess-remote',
        machineId: 'target-machine',
        path: '/remote/repo',
        metadata: { machineId: 'target-machine' },
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });
    routeSessionGoalControl.mockResolvedValue({ ok: true });

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'target-machine',
        metadata: { machineId: 'target-machine' },
      },
    });

    await expect(deps.sessionGoalGet?.({ sessionId: 'sess-remote' })).resolves.toEqual({ ok: true });

    expect(routeSessionGoalControl).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-remote',
      currentMachineId: 'local-machine',
    }));
  });

  it('routes usage-limit wait-resume controls through the recovery control router when enabled', async () => {
    const recovery = {
      v: 1,
      status: 'waiting',
      issueFingerprint: 'usage-limit:sess-remote:reset',
      armedAtMs: 1,
      resetAtMs: 2,
      nextCheckAtMs: 2,
      attemptCount: 0,
      maxAttempts: 3,
      lastProbeError: null,
      selectedAuth: { kind: 'native' },
      resumePromptMode: 'off',
    } as const;
    const scheduleInactiveSessionUsageLimitRecoveryCheck = vi.fn();
    const cancelInactiveSessionUsageLimitRecoveryCheck = vi.fn();
    routeSessionUsageLimitRecoveryWaitResumeEnable.mockResolvedValueOnce({
      ok: true,
      recovery: { status: 'waiting' },
      metadata: {
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: recovery,
      },
    });
    routeSessionUsageLimitRecoveryWaitResumeCancel.mockResolvedValueOnce({ ok: true, recovery: { status: 'cancelled' } });
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-remote',
      rawSession: {
        id: 'sess-remote',
        active: false,
        path: '/repo',
        machineId: 'target-machine',
        metadata: { machineId: 'target-machine' },
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });
    callSessionRpc.mockResolvedValue({ ok: true, recovery: { status: 'waiting' } });

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        metadata: {},
      },
      isUsageLimitRecoveryEnabled: async () => true,
      scheduleInactiveSessionUsageLimitRecoveryCheck,
      cancelInactiveSessionUsageLimitRecoveryCheck,
    });

    await expect(deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess-remote',
      issueFingerprint: 'usage-limit:sess-remote:reset',
      remember: true,
      resumePromptMode: 'off',
    })).resolves.toMatchObject({ ok: true, status: 'waiting', sessionId: 'sess-remote' });
    await expect(deps.sessionUsageLimitWaitResumeCancel?.({
      sessionId: 'sess-remote',
      issueFingerprint: null,
    })).resolves.toEqual({ ok: true, status: 'cancelled', sessionId: 'sess-remote' });
    expect(callSessionRpc).not.toHaveBeenCalled();
    expect(routeSessionUsageLimitRecoveryWaitResumeEnable).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-remote',
      currentMachineId: 'local-machine',
      request: {
        sessionId: 'sess-remote',
        issueFingerprint: 'usage-limit:sess-remote:reset',
        rememberPreference: true,
        resumePromptMode: 'off',
      },
    }));
    expect(routeSessionUsageLimitRecoveryWaitResumeCancel).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-remote',
      currentMachineId: 'local-machine',
      request: {
        sessionId: 'sess-remote',
        issueFingerprint: null,
      },
    }));
    expect(scheduleInactiveSessionUsageLimitRecoveryCheck).toHaveBeenCalledWith({
      sessionId: 'sess-remote',
      recovery,
      runCheckNow: expect.any(Function),
    });
    routeSessionUsageLimitRecoveryCheckNow.mockResolvedValueOnce({ ok: true, status: 'ready' });
    await expect(scheduleInactiveSessionUsageLimitRecoveryCheck.mock.calls[0]?.[0].runCheckNow()).resolves.toEqual({
      ok: true,
      status: 'ready',
      sessionId: 'sess-remote',
    });
    expect(routeSessionUsageLimitRecoveryCheckNow).toHaveBeenCalledWith(expect.objectContaining({
      request: {
        sessionId: 'sess-remote',
        resumePromptMode: 'off',
      },
    }));
    expect(cancelInactiveSessionUsageLimitRecoveryCheck).toHaveBeenCalledWith({
      sessionId: 'sess-remote',
    });
  });

  it('routes usage-limit check-now through the recovery control router when enabled', async () => {
    routeSessionUsageLimitRecoveryCheckNow.mockResolvedValueOnce({ ok: true, status: 'ready' });
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-remote',
      rawSession: {
        id: 'sess-remote',
        active: false,
        path: '/repo',
        machineId: 'target-machine',
        metadata: { machineId: 'target-machine' },
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });
    readSettings.mockResolvedValue({ machineId: 'target-machine' });
    const resumeInactiveSessionWhenUsageLimitReady = vi.fn(async () => true);
    const retryTemporaryThrottleNow = vi.fn(async () => ({ status: 'resumed' }));

    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        metadata: {},
      },
      isUsageLimitRecoveryEnabled: async () => true,
      resumeInactiveSessionWhenUsageLimitReady,
      retryTemporaryThrottleNow,
    });

    await expect(deps.sessionUsageLimitCheckNow?.({
      sessionId: 'sess-remote',
      provider: ' codex ',
    })).resolves.toEqual({ ok: true, status: 'ready', sessionId: 'sess-remote' });

    expect(callSessionRpc).not.toHaveBeenCalled();
    expect(routeSessionUsageLimitRecoveryCheckNow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-remote',
      currentMachineId: 'target-machine',
      rawSession: expect.objectContaining({ active: false }),
      request: { sessionId: 'sess-remote', provider: 'codex' },
      resumeInactiveSessionWhenReady: expect.any(Function),
      retryTemporaryThrottleNow,
    }));
    await expect(routeSessionUsageLimitRecoveryCheckNow.mock.calls[0]?.[0].resumeInactiveSessionWhenReady({
      sessionId: 'sess-remote',
      rawSession: { id: 'sess-remote' },
      metadata: { machineId: 'target-machine' },
    })).resolves.toBe(true);
    expect(resumeInactiveSessionWhenUsageLimitReady).toHaveBeenCalledWith({
      sessionId: 'sess-remote',
      rawSession: { id: 'sess-remote' },
      metadata: { machineId: 'target-machine' },
    });
  });

  it('routes usage-limit switch-account controls through daemon runtime-auth recovery', async () => {
    routeSessionUsageLimitRecoverySwitchAccountNow.mockResolvedValueOnce({ ok: true, status: 'waiting' });
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-group',
      rawSession: {
        id: 'sess-group',
        active: true,
        latestTurnStatus: 'failed',
        lastRuntimeIssue: {
          v: 1,
          scope: 'primary_session',
          status: 'failed',
          code: 'usage_limit',
          source: 'usage_limit',
          provider: 'codex',
          providerTurnId: 'turn-1',
          occurredAt: 1_700_000_000_000,
          usageLimit: {
            v: 1,
            resetAtMs: null,
            retryAfterMs: null,
            quotaScope: 'account',
            recoverability: 'switch_account',
            connectedService: {
              serviceId: 'openai-codex',
              profileId: 'primary',
              groupId: 'codex-main',
            },
          },
        },
        metadata: {
          machineId: 'target-machine',
        },
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
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
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        metadata: {},
      },
      isUsageLimitRecoveryEnabled: async () => true,
    });

    await expect(deps.sessionUsageLimitSwitchAccountNow?.({
      sessionId: 'sess-group',
      provider: ' codex ',
      resumePromptMode: 'custom',
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'sess-group' });

    expect(callSessionRpc).not.toHaveBeenCalled();
    expect(routeSessionUsageLimitRecoverySwitchAccountNow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-group',
      rawSession: expect.objectContaining({ active: true }),
      request: { sessionId: 'sess-group', provider: 'codex', resumePromptMode: 'custom' },
    }));
  });

  it('normalizes usage-limit recovery action-deps authentication failures', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        metadata: {},
      },
      isUsageLimitRecoveryEnabled: async () => true,
    });

    await expect(deps.sessionUsageLimitCheckNow?.({
      sessionId: 'sess-remote',
    })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess-remote',
      errorCode: 'not_authenticated',
    });
    expect(resolveSessionTransportContext).not.toHaveBeenCalled();
  });

  it('normalizes usage-limit recovery action-deps transport failures', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: false,
      code: 'session_transport_unresolved',
      candidates: [{ sessionId: 'other-session' }],
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
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        metadata: {},
      },
      isUsageLimitRecoveryEnabled: async () => true,
    });

    await expect(deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess-remote',
    })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess-remote',
      errorCode: 'session_transport_unresolved',
    });
  });

  it('fails closed for usage-limit recovery controls when the feature is disabled', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy',
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        metadata: {},
      },
      isUsageLimitRecoveryEnabled: async () => false,
    });

    await expect(deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess-remote',
    })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess-remote',
      errorCode: 'feature_disabled',
    });

    expect(callSessionRpc).not.toHaveBeenCalled();
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
