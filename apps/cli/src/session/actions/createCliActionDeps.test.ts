import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderConnectionIdSchema,
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
} from '@happier-dev/protocol';

const {
  createSpawnedSession,
  sendSessionMessage,
  createCliApprovalsArtifactStore,
  emitSessionLifecycleHookEvent,
  resolveSessionTransportContext,
  listExecutionRuns,
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
  setSessionModel,
} = vi.hoisted(() => ({
  createSpawnedSession: vi.fn(),
  sendSessionMessage: vi.fn(),
  createCliApprovalsArtifactStore: vi.fn(() => ({})),
  emitSessionLifecycleHookEvent: vi.fn(),
  resolveSessionTransportContext: vi.fn(),
  listExecutionRuns: vi.fn(),
  executeExecutionRunAction: vi.fn(),
  callSessionRpc: vi.fn(),
  routeSessionGoalControl: vi.fn(),
  routeSessionCatalogControl: vi.fn(),
  routeSessionUsageLimitRecoveryCheckNow: vi.fn(),
  routeSessionUsageLimitRecoverySwitchAccountNow: vi.fn(),
  routeSessionUsageLimitRecoveryWaitResumeCancel: vi.fn(),
  routeSessionUsageLimitRecoveryWaitResumeEnable: vi.fn(),
  readSettings: vi.fn(),
  setSessionModel: vi.fn(),
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

vi.mock('@/session/services/setSessionModel', () => ({
  setSessionModel,
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
    listExecutionRuns,
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
    listExecutionRuns.mockReset();
    executeExecutionRunAction.mockReset();
    callSessionRpc.mockReset();
    routeSessionGoalControl.mockReset();
    routeSessionCatalogControl.mockReset();
    routeSessionUsageLimitRecoveryCheckNow.mockReset();
    routeSessionUsageLimitRecoverySwitchAccountNow.mockReset();
    routeSessionUsageLimitRecoveryWaitResumeCancel.mockReset();
    routeSessionUsageLimitRecoveryWaitResumeEnable.mockReset();
    readSettings.mockReset();
    setSessionModel.mockReset();
    readSettings.mockResolvedValue({ machineId: 'local-machine' });
    hostSubagentStore.list.mockReset();
    hostSubagentStore.get.mockReset();
    hostSubagentStore.watch.mockReset();
    hostSubagentStore.upsert.mockReset();
    hostSubagentStore.updateStatus.mockReset();
    hostSubagentStore.complete.mockReset();
  });

  it('preserves provider connection identity when setting a session model', async () => {
    setSessionModel.mockResolvedValue({ ok: true, sessionId: 'sess-1' });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
    });

    await expect(deps.sessionModelSet?.({
      sessionId: 'sess-1',
      modelId: 'model-a',
      providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
    })).resolves.toMatchObject({ ok: true, sessionId: 'sess-1', modelId: 'model-a' });

    expect(setSessionModel).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'sess-1',
      modelId: 'model-a',
      providerConnectionId: 'pc_work',
    }));
  });

  it('surfaces the structured restart action when a session model change would switch providers', async () => {
    setSessionModel.mockResolvedValue({
      ok: false,
      code: 'provider_switch_unsupported',
      providerError: {
        v: 1,
        code: 'provider_switch_unsupported',
        retryable: false,
        action: 'review_and_restart',
      },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
    });

    await expect(deps.sessionModelSet?.({
      sessionId: 'sess-1',
      modelId: 'model-a',
      providerConnectionId: 'pc_other',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'provider_switch_unsupported',
      error: 'provider_switch_unsupported',
      details: {
        v: 1,
        code: 'provider_switch_unsupported',
        retryable: false,
        action: 'review_and_restart',
      },
    });
  });

  it('dispatches a session.spawned lifecycle hook after session.spawn_new succeeds', async () => {
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
          type: 'legacy' as const,
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
      providerConnectionId: 'pc_work',
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
      modelSelection: {
        v: 1,
        updatedAt: expect.any(Number),
        ref: {
          agentTargetKey: 'backend:claude',
          providerConnectionId: 'pc_work',
          modelId: 'gpt-4o',
        },
      },
    }));
    expect(emitSessionLifecycleHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      happyHomeDir: '/tmp/happier-home',
      eventId: 'session.spawned',
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

    emitSessionLifecycleHookEvent.mockClear();
    await deps.sessionSendMessage({
      sessionId: 'sess-1',
      message: 'Use the current connection',
      modelOverride: 'default',
    });
    expect(sendSessionMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      modelSelectionInput: { modelId: 'default' },
    }));
    const hookPayload = emitSessionLifecycleHookEvent.mock.calls[0]?.[0]?.payload as Readonly<Record<string, unknown>>;
    expect(hookPayload).not.toHaveProperty('modelOverride');
    expect(hookPayload).not.toHaveProperty('providerConnectionId');
  });

  it('rejects a provider connection without an explicit model selection', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: { machineId: 'machine-1', path: '/repo', metadata: {} },
    });

    await expect(deps.sessionSpawnNew({
      backendTargetKey: 'agent:claude',
      providerConnectionId: 'pc_work',
    })).resolves.toMatchObject({ type: 'error', errorCode: 'invalid_parameters' });
    expect(createSpawnedSession).not.toHaveBeenCalled();
  });

  it('preserves a provider model whose literal id is default', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-new',
      session: { id: 'sess-new' },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: { machineId: 'machine-1', path: '/repo', metadata: {} },
    });

    await expect(deps.sessionSpawnNew({
      backendTargetKey: 'agent:claude',
      providerConnectionId: 'pc_work',
      modelId: 'default',
    })).resolves.toMatchObject({ type: 'success', sessionId: 'sess-new' });
    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      modelSelection: expect.objectContaining({
        ref: {
          agentTargetKey: 'backend:claude',
          providerConnectionId: 'pc_work',
          modelId: 'default',
        },
      }),
    }));
  });

  it('refuses inherited model intent when the source agent target is unknown', async () => {
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'machine-1',
        path: '/repo',
        metadata: { modelOverrideV1: { v: 1, updatedAt: 1, modelId: 'model-a' } },
      },
    });

    await expect(deps.sessionSpawnNew({
      backendTargetKey: 'agent:codex',
    })).resolves.toMatchObject({ type: 'error', errorCode: 'invalid_parameters' });
    expect(createSpawnedSession).not.toHaveBeenCalled();
  });

  it('inherits current session metadata-backed spawn fields when session.spawn_new omits them', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-child',
      session: { id: 'sess-child' },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy' as const,
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'machine-1',
        host: 'localhost',
        metadata: {
          flavor: 'claude',
          path: '/repo',
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 123,
          modelOverrideV1: { v: 1, updatedAt: 456, modelId: 'gpt-test' },
          acpSessionModeOverrideV1: { v: 1, updatedAt: 457, modeId: 'plan' },
          acpConfigOptionOverridesV1: {
            v: 1,
            updatedAt: 458,
            overrides: {
              effort: { updatedAt: 458, value: 'xhigh' },
            },
          },
          connectedServices: {
            v: 1,
            bindingsByServiceId: {
              'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
            },
          },
          connectedServicesUpdatedAt: 459,
          profileId: 'profile-parent',
          mcpSelectionV1: {
            v: 1,
            managedServersEnabled: false,
            forceIncludeServerIds: ['local-search'],
            forceExcludeServerIds: ['prod-browser'],
          },
        },
      },
    });

    await expect(deps.sessionSpawnNew({
      backendTargetKey: 'agent:codex',
      title: 'Inherited child',
    })).resolves.toEqual({
      type: 'success',
      sessionId: 'sess-child',
      created: true,
      session: { id: 'sess-child' },
    });

    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      credentials: expect.objectContaining({ token: 'token' }),
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      title: 'Inherited child',
      permissionMode: 'safe-yolo',
      permissionModeUpdatedAt: 123,
      agentModeId: 'plan',
      agentModeUpdatedAt: 457,
      sessionConfigOptionOverrides: {
        v: 1,
        updatedAt: 458,
        overrides: {
          effort: { updatedAt: 458, value: 'xhigh' },
        },
      },
      connectedServices: {
        v: 1,
        bindingsByServiceId: {
          'openai-codex': { source: 'connected', selection: 'profile', profileId: 'work' },
        },
      },
      connectedServicesUpdatedAt: 459,
      profileId: 'profile-parent',
      mcpSelection: {
        v: 1,
        managedServersEnabled: false,
        forceIncludeServerIds: ['local-search'],
        forceExcludeServerIds: ['prod-browser'],
      },
    }));
    expect(vi.mocked(createSpawnedSession).mock.calls.at(-1)?.[0]).not.toHaveProperty('modelSelection');
  });

  it('inherits current session backend target when session-agent spawn omits an explicit target', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-child-configured',
      session: { id: 'sess-child-configured' },
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
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'machine-1',
        host: 'localhost',
        metadata: {
          path: '/repo',
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 123,
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'claude',
            agent: {},
          },
        },
      },
      getCurrentSessionBackendTarget: () => ({
        kind: 'backend',
        backendId: 'review-bot',
        sourceKind: 'configured',
        configuredBackendId: 'review-bot',
      }),
    });

    await expect(deps.sessionSpawnNew({
      title: 'Inherited configured backend child',
      callerSurface: 'agent',
      callerPermissionMode: 'safe-yolo',
    })).resolves.toEqual({
      type: 'success',
      sessionId: 'sess-child-configured',
      created: true,
      session: { id: 'sess-child-configured' },
    });

    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        sourceKind: 'configured',
        configuredBackendId: 'review-bot',
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'claude',
        agent: {},
      },
      title: 'Inherited configured backend child',
    }));
  });

  it('inherits runtime descriptor metadata when session-agent spawn omits runtime and backend target', async () => {
    const inheritedRuntimeDescriptor = {
      v: 1,
      agentId: 'opencode',
      agent: {
        backendMode: 'server',
        providerSessionId: 'sess_opencode_parent',
        serverBaseUrl: 'http://127.0.0.1:4096/',
        serverBaseUrlExplicit: true,
      },
    } as const;
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-child-runtime',
      session: { id: 'sess-child-runtime' },
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
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'machine-1',
        path: '/repo',
        metadata: {
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 123,
          runtimeDescriptorV1: inheritedRuntimeDescriptor,
        },
      },
    });

    await expect(deps.sessionSpawnNew({
      title: 'Inherited runtime child',
      callerSurface: 'agent',
      callerPermissionMode: 'safe-yolo',
    })).resolves.toEqual({
      type: 'success',
      sessionId: 'sess-child-runtime',
      created: true,
      session: { id: 'sess-child-runtime' },
    });

    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: {
        kind: 'backend',
        backendId: 'opencode',
        sourceKind: 'built_in',
      },
      runtimeDescriptorV1: inheritedRuntimeDescriptor,
      title: 'Inherited runtime child',
    }));
  });

  it('inherits configured ACP backend metadata before runtime descriptor metadata', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-child-configured-metadata',
      session: { id: 'sess-child-configured-metadata' },
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
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'machine-1',
        path: '/repo',
        metadata: {
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 123,
          acpConfiguredBackendV1: {
            v: 1,
            backendId: 'review-bot',
            title: 'Review Bot',
            updatedAt: 120,
          },
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'claude',
            agent: {},
          },
        },
      },
    });

    await expect(deps.sessionSpawnNew({
      title: 'Inherited configured metadata child',
      callerSurface: 'agent',
      callerPermissionMode: 'safe-yolo',
    })).resolves.toEqual({
      type: 'success',
      sessionId: 'sess-child-configured-metadata',
      created: true,
      session: { id: 'sess-child-configured-metadata' },
    });

    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      machineId: 'machine-1',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        sourceKind: 'configured',
        configuredBackendId: 'review-bot',
      },
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'claude',
        agent: {},
      },
      title: 'Inherited configured metadata child',
    }));
  });

  it('rejects session-agent spawn permission escalation before creating a child session', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-should-not-spawn',
      session: { id: 'sess-should-not-spawn' },
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
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'machine-1',
        path: '/repo',
        metadata: {
          permissionMode: 'default',
          permissionModeUpdatedAt: 100,
        },
      },
    });

    await expect(deps.sessionSpawnNew({
      path: '/repo',
      backendTargetKey: 'agent:codex',
      permissionMode: 'workspace_write',
      callerSurface: 'agent',
    })).resolves.toEqual(expect.objectContaining({
      type: 'error',
      errorCode: 'permission_escalation_denied',
      errorMessage: 'permission_escalation_denied',
    }));
    expect(createSpawnedSession).not.toHaveBeenCalled();
  });

  it('uses the live caller permission accessor before metadata for session-agent spawn', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-child-live-permission',
      session: { id: 'sess-child-live-permission' },
    });
    const params = {
      token: 'token',
      credentials: {
        token: 'token',
        encryption: {
          type: 'legacy' as const,
          secret: new Uint8Array([1, 2, 3, 4]),
        },
      },
      sessionId: 'sess-parent',
      mode: 'plain' as const,
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy' as const,
      },
      rawSession: {
        machineId: 'machine-1',
        path: '/repo',
        metadata: {
          permissionMode: 'default',
          permissionModeUpdatedAt: 100,
        },
      },
      getCallerPermissionMode: () => 'yolo',
    };
    const deps = createCliActionDeps(params);

    await expect(deps.sessionSpawnNew({
      path: '/repo',
      backendTargetKey: 'agent:codex',
      permissionMode: 'yolo',
      callerSurface: 'agent',
    })).resolves.toEqual({
      type: 'success',
      sessionId: 'sess-child-live-permission',
      created: true,
      session: { id: 'sess-child-live-permission' },
    });

    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/repo',
      permissionMode: 'yolo',
    }));
  });

  it('rejects session-agent spawn policy field denials before creating a child session', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-should-not-spawn',
      session: { id: 'sess-should-not-spawn' },
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
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'machine-1',
        path: '/repo',
        metadata: {
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 100,
        },
      },
    });

    await expect(deps.sessionSpawnNew({
      path: '/tmp/other-repo',
      backendTargetKey: 'agent:codex',
      callerSurface: 'agent',
      sessionAgentSpawnPolicyV1: {
        v: 1,
        allowCustomDirectory: false,
      },
    })).resolves.toEqual(expect.objectContaining({
      type: 'error',
      errorCode: 'spawn_policy_denied',
      errorMessage: 'spawn_policy_denied',
      field: 'path',
    }));
    expect(createSpawnedSession).not.toHaveBeenCalled();
  });

  it('allows explicit session-agent spawn overrides with the default-open spawn policy', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-child',
      session: { id: 'sess-child' },
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
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'machine-1',
        path: '/repo',
        metadata: {
          permissionMode: 'safe-yolo',
          permissionModeUpdatedAt: 100,
        },
      },
    });

    await expect(deps.sessionSpawnNew({
      path: '/tmp/other-repo',
      backendTargetKey: 'agent:codex',
      permissionMode: 'read_only',
      environmentVariables: { FEATURE_FLAG: 'enabled' },
      callerSurface: 'agent',
    })).resolves.toEqual({
      type: 'success',
      sessionId: 'sess-child',
      created: true,
      session: { id: 'sess-child' },
    });
    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      directory: '/tmp/other-repo',
      permissionMode: 'read-only',
      environmentVariables: { FEATURE_FLAG: 'enabled' },
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
      providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
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
      modelSelectionInput: {
        providerConnectionId: 'pc_work',
        modelId: 'gpt-4o',
      },
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
        providerConnectionId: 'pc_work',
      }),
    }));
  });

  it('rejects session-agent message permission overrides above the caller permission ordinal', async () => {
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
          permissionMode: 'default',
          permissionModeUpdatedAt: 100,
        },
      },
    });

    await expect(deps.sessionSendMessage({
      sessionId: 'sess-1',
      message: 'Hello world',
      permissionModeOverride: 'workspace_write',
      callerSurface: 'agent',
    })).resolves.toEqual(expect.objectContaining({
      ok: false,
      errorCode: 'permission_escalation_denied',
      error: 'permission_escalation_denied',
    }));
    expect(sendSessionMessage).not.toHaveBeenCalled();
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

  it('routes terminal composer clear through the live session RPC transport', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-remote',
      rawSession: {
        metadata: {},
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });
    callSessionRpc.mockResolvedValue({ ok: true, status: 'cleared', sessionId: 'sess-remote' });

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
    });

    await expect((deps as any).sessionTerminalComposerClear({
      sessionId: 'sess-remote',
      expectedStateAtMs: 42,
    })).resolves.toEqual({ ok: true, status: 'cleared', sessionId: 'sess-remote' });

    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      token: 'token',
      sessionId: 'sess-remote',
      method: 'sess-remote:session.terminalComposer.clear',
      request: {
        sessionId: 'sess-remote',
        expectedStateAtMs: 42,
      },
    }));
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
    const cancelConnectedServiceRuntimeAuthRecovery = vi.fn(async () => ({ ok: true }));
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
      cancelConnectedServiceRuntimeAuthRecovery,
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
    expect(cancelConnectedServiceRuntimeAuthRecovery).toHaveBeenCalledWith({
      sessionId: 'sess-remote',
    });
  });

  it('skips live execution-run list rpc for inactive resolved sessions', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-inactive',
      rawSession: {
        id: 'sess-inactive',
        active: false,
        metadata: {},
      },
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      mode: 'plain',
    });
    listExecutionRuns.mockResolvedValue({ ok: true, data: { runs: [] } });

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
    });

    await expect(deps.executionRunList('sess-inactive', { limit: 5 })).resolves.toEqual({
      ok: true,
      data: { runs: [] },
    });

    expect(listExecutionRuns).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-inactive',
      request: { limit: 5 },
      skipLiveRpc: true,
    }));
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
      agentId: ' codex ',
    })).resolves.toEqual({ ok: true, status: 'ready', sessionId: 'sess-remote' });

    expect(callSessionRpc).not.toHaveBeenCalled();
    expect(routeSessionUsageLimitRecoveryCheckNow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-remote',
      currentMachineId: 'target-machine',
      rawSession: expect.objectContaining({ active: false }),
      request: { sessionId: 'sess-remote', agentId: 'codex' },
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

  it('routes usage-limit reset-credit consumption through the recovery control router', async () => {
    routeSessionUsageLimitRecoveryCheckNow.mockResolvedValueOnce({ ok: true, status: 'waiting' });
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-remote',
      rawSession: {
        id: 'sess-remote',
        active: true,
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

    await expect(deps.sessionUsageLimitConsumeResetCredit?.({
      sessionId: 'sess-remote',
      agentId: ' codex ',
      resumePromptMode: 'custom',
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'sess-remote' });

    expect(callSessionRpc).not.toHaveBeenCalled();
    expect(routeSessionUsageLimitRecoveryCheckNow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-remote',
      currentMachineId: 'target-machine',
      rawSession: expect.objectContaining({ active: true }),
      request: {
        sessionId: 'sess-remote',
        agentId: 'codex',
        operation: 'consume_reset_credit',
        resumePromptMode: 'custom',
      },
    }));
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
          agentId: 'codex',
          agentTurnId: 'turn-1',
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
      agentId: ' codex ',
      resumePromptMode: 'custom',
    })).resolves.toEqual({ ok: true, status: 'waiting', sessionId: 'sess-group' });

    expect(callSessionRpc).not.toHaveBeenCalled();
    expect(routeSessionUsageLimitRecoverySwitchAccountNow).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-group',
      rawSession: expect.objectContaining({ active: true }),
      request: { sessionId: 'sess-group', agentId: 'codex', resumePromptMode: 'custom' },
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
