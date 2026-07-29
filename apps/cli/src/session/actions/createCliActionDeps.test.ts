import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderConnectionIdSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

const {
  createSpawnedSession,
  sendSessionMessage,
  createCliApprovalsArtifactStore,
  emitSessionLifecycleHookEvent,
  resolveSessionTransportContext,
  listExecutionRuns,
  executeExecutionRunAction,
  callSessionRpc,
  callMachineRpc,
  hostSubagentStore,
  routeSessionGoalControl,
  routeSessionCatalogControl,
  routeSessionUsageLimitRecoveryCheckNow,
  routeSessionUsageLimitRecoverySwitchAccountNow,
  routeSessionUsageLimitRecoveryWaitResumeCancel,
  routeSessionUsageLimitRecoveryWaitResumeEnable,
  readSettings,
  getPreferredHostName,
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
  callMachineRpc: vi.fn(),
  routeSessionGoalControl: vi.fn(),
  routeSessionCatalogControl: vi.fn(),
  routeSessionUsageLimitRecoveryCheckNow: vi.fn(),
  routeSessionUsageLimitRecoverySwitchAccountNow: vi.fn(),
  routeSessionUsageLimitRecoveryWaitResumeCancel: vi.fn(),
  routeSessionUsageLimitRecoveryWaitResumeEnable: vi.fn(),
  readSettings: vi.fn(),
  getPreferredHostName: vi.fn(),
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

vi.mock('@/session/transport/rpc/machineRpc', () => ({
  callMachineRpc,
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

vi.mock('@/daemon/machine/metadata', () => ({
  getPreferredHostName,
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
    listExecutionRuns.mockReset();
    executeExecutionRunAction.mockReset();
    callSessionRpc.mockReset();
    callMachineRpc.mockReset();
    routeSessionGoalControl.mockReset();
    routeSessionCatalogControl.mockReset();
    routeSessionUsageLimitRecoveryCheckNow.mockReset();
    routeSessionUsageLimitRecoverySwitchAccountNow.mockReset();
    routeSessionUsageLimitRecoveryWaitResumeCancel.mockReset();
    routeSessionUsageLimitRecoveryWaitResumeEnable.mockReset();
    readSettings.mockReset();
    getPreferredHostName.mockReset();
    setSessionModel.mockReset();
    readSettings.mockResolvedValue({ machineId: 'local-machine' });
    getPreferredHostName.mockResolvedValue('local-machine.local');
    hostSubagentStore.list.mockReset();
    hostSubagentStore.get.mockReset();
    hostSubagentStore.watch.mockReset();
    hostSubagentStore.upsert.mockReset();
    hostSubagentStore.updateStatus.mockReset();
    hostSubagentStore.complete.mockReset();
  });

  it('preserves the active transition owner result when setting a session model', async () => {
    setSessionModel.mockResolvedValue({
      ok: true,
      status: 'applied',
      sessionId: 'sess-1',
      modelId: 'model-a',
      activeSelection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'model-a',
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
      providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
    })).resolves.toEqual({
      ok: true,
      status: 'applied',
      sessionId: 'sess-1',
      modelId: 'model-a',
      activeSelection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: 'pc_work',
        modelId: 'model-a',
      },
    });

    expect(setSessionModel).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'sess-1',
      modelId: 'model-a',
      providerConnectionId: 'pc_work',
    }));
  });

  it('preserves the inactive intent owner timestamp and structured selection', async () => {
    const selection = {
      agentTargetKey: 'backend:codex',
      providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
      modelId: 'model-a',
    };
    setSessionModel.mockResolvedValue({
      ok: true,
      status: 'intent_updated',
      sessionId: 'sess-1',
      modelId: 'model-a',
      selection,
      updatedAt: 123,
      metadata: { ignored: true },
      version: 7,
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
      providerConnectionId: selection.providerConnectionId,
    })).resolves.toEqual({
      ok: true,
      status: 'intent_updated',
      sessionId: 'sess-1',
      modelId: 'model-a',
      selection,
      updatedAt: 123,
    });
  });

  it('preserves exact active and requested facts when a session model transition requires restart', async () => {
    setSessionModel.mockResolvedValue({
      ok: false,
      status: 'restart_required',
      sessionId: 'sess-1',
      activeSelection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_work'),
        modelId: 'model-old',
      },
      requestedSelection: {
        agentTargetKey: 'backend:codex',
        providerConnectionId: ProviderConnectionIdSchema.parse('pc_other'),
        modelId: 'model-a',
      },
      reason: 'provider_source_change_requires_restart',
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
      errorCode: 'restart_required',
      error: 'restart_required',
      details: {
        status: 'restart_required',
        activeSelection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_work',
          modelId: 'model-old',
        },
        requestedSelection: {
          agentTargetKey: 'backend:codex',
          providerConnectionId: 'pc_other',
          modelId: 'model-a',
        },
        reason: 'provider_source_change_requires_restart',
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
      backendTarget: 'backend:claude',
      payload: {
        sessionId: 'sess-new',
        agentId: 'claude',
        runtimeTarget: {
          kind: 'backend',
          backendId: 'claude',
          sourceKind: 'built_in',
        },
        cwd: '/repo',
        tag: 'tag-1',
        modelId: 'gpt-4o',
        initialMessage: 'Hello from spawn',
        machineId: 'machine-1',
      },
    }));
    expect(emitSessionLifecycleHookEvent.mock.calls[0]?.[0]).not.toHaveProperty('workspaceId');

    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      localId: 'local-current-connection',
      waited: false,
    });
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

  it('uses the exact local machine when machineId is explicit and its normalized host assertion matches', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-explicit',
      session: { id: 'sess-explicit' },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'parent-machine',
        path: '/repo/parent',
        host: 'parent-machine',
        metadata: {
          workspaceId: 'parent-workspace',
        },
      },
      happyHomeDir: '/tmp/happier-home',
    });

    await expect(deps.sessionSpawnNew({
      machineId: 'local-machine',
      host: 'LOCAL-MACHINE',
      path: '/repo/explicit',
      backendTargetKey: 'agent:claude',
    })).resolves.toMatchObject({ type: 'success', sessionId: 'sess-explicit' });

    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'local-machine',
      directory: '/repo/explicit',
    }));
    const emitted = emitSessionLifecycleHookEvent.mock.calls.at(-1)?.[0];
    expect(emitted).toEqual(expect.objectContaining({
      happySessionId: 'sess-explicit',
      machineId: 'local-machine',
      cwd: '/repo/explicit',
      payload: expect.objectContaining({
        sessionId: 'sess-explicit',
        machineId: 'local-machine',
        cwd: '/repo/explicit',
      }),
    }));
    expect(emitted).not.toHaveProperty('workspaceId');
  });

  it.each([
    {
      name: 'unknown machine identity',
      input: { machineId: 'unknown-machine', path: '/repo/explicit' },
    },
    {
      name: 'conflicting host assertion',
      input: { machineId: 'local-machine', host: 'another-machine', path: '/repo/explicit' },
    },
    {
      name: 'different server scope',
      input: { machineId: 'local-machine', serverId: 'definitely-not-the-active-server', path: '/repo/explicit' },
    },
  ])('fails an explicit $name with invalid_parameters before spawn', async ({ input }) => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-unexpected',
      session: { id: 'sess-unexpected' },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'parent-machine',
        path: '/repo/parent',
        host: 'parent-machine',
        metadata: {},
      },
    });

    await expect(deps.sessionSpawnNew({
      ...input,
      backendTargetKey: 'agent:claude',
    })).resolves.toEqual({
      type: 'error',
      errorCode: 'invalid_parameters',
      errorMessage: 'invalid_parameters',
    });
    expect(createSpawnedSession).not.toHaveBeenCalled();
  });

  it('does not borrow the current session directory for a different explicit machine', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-unexpected',
      session: { id: 'sess-unexpected' },
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-parent',
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([1, 2, 3, 4]),
        encryptionVariant: 'legacy',
      },
      rawSession: {
        machineId: 'parent-machine',
        path: '/repo/parent',
        host: 'parent-machine',
        metadata: {},
      },
    });

    await expect(deps.sessionSpawnNew({
      machineId: 'local-machine',
      backendTargetKey: 'agent:claude',
    })).resolves.toEqual({
      type: 'error',
      errorCode: 'spawn_target_missing',
      errorMessage: 'spawn_target_missing',
    });
    expect(createSpawnedSession).not.toHaveBeenCalled();
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
      happyHomeDir: '/tmp/happier-home',
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
    expect(emitSessionLifecycleHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      happySessionId: 'sess-child-configured',
      payload: expect.objectContaining({
        sessionId: 'sess-child-configured',
        agentId: 'claude',
        runtimeTarget: {
          kind: 'backend',
          backendId: 'review-bot',
          sourceKind: 'configured',
          configuredBackendId: 'review-bot',
        },
      }),
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

  it('does not inherit a parent runtime descriptor when an explicit built-in Agent target is requested', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-explicit-agent-child',
      session: { id: 'sess-explicit-agent-child' },
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
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'claude',
            agent: {},
          },
        },
      },
      happyHomeDir: '/tmp/happier-home',
    });

    await expect(deps.sessionSpawnNew({
      path: '/repo',
      backendTargetKey: 'agent:codex',
    })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'sess-explicit-agent-child',
    });

    const spawnInput = vi.mocked(createSpawnedSession).mock.calls.at(-1)?.[0];
    expect(spawnInput).toEqual(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
    }));
    expect(spawnInput).not.toHaveProperty('runtimeDescriptorV1');
    expect(emitSessionLifecycleHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      happySessionId: 'sess-explicit-agent-child',
      payload: expect.objectContaining({
        sessionId: 'sess-explicit-agent-child',
        agentId: 'codex',
      }),
    }));
  });

  it('does not publish a configured backend id as an Agent id when no carrier Agent is known', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-configured-without-carrier',
      session: { id: 'sess-configured-without-carrier' },
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
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'claude',
            agent: {},
          },
        },
      },
      happyHomeDir: '/tmp/happier-home',
    });

    await expect(deps.sessionSpawnNew({
      path: '/repo',
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        sourceKind: 'configured',
        configuredBackendId: 'review-bot',
      },
    })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'sess-configured-without-carrier',
    });

    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        sourceKind: 'configured',
        configuredBackendId: 'review-bot',
      },
    }));
    expect(vi.mocked(createSpawnedSession).mock.calls.at(-1)?.[0]).not.toHaveProperty('runtimeDescriptorV1');
    expect(emitSessionLifecycleHookEvent).not.toHaveBeenCalled();
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

  it('consumes inherited legacy ACP runtime descriptors without copying their carrier into a child or hook', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-child-configured-legacy-runtime',
      session: { id: 'sess-child-configured-legacy-runtime' },
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
          acpConfiguredBackendV1: {
            v: 1,
            backendId: 'review-bot',
            title: 'Review Bot',
            updatedAt: 120,
          },
          runtimeDescriptorV1: {
            v: 1,
            agentId: 'customAcp',
            agent: {},
          },
        },
      },
      happyHomeDir: '/tmp/happier-home',
    });

    await expect(deps.sessionSpawnNew({
      title: 'Inherited configured metadata child',
    })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'sess-child-configured-legacy-runtime',
    });

    const spawnInput = vi.mocked(createSpawnedSession).mock.calls.at(-1)?.[0];
    expect(spawnInput).toEqual(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'review-bot',
        sourceKind: 'configured',
        configuredBackendId: 'review-bot',
      },
    }));
    expect(spawnInput).not.toHaveProperty('runtimeDescriptorV1');
    expect(emitSessionLifecycleHookEvent).not.toHaveBeenCalled();
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

  it('routes structured plugin lifecycle hooks by the reconciled backend target, not the runtime Agent', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-structured-plugin',
      session: { id: 'sess-structured-plugin' },
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

    await expect(deps.sessionSpawnNew({
      agentId: 'claude',
      backendTarget: {
        kind: 'backend',
        backendId: 'plugin-review-bot',
        sourceKind: 'built_in',
      },
      path: '/repo',
    })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'sess-structured-plugin',
    });

    expect(emitSessionLifecycleHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventId: 'session.spawned',
      backendTarget: 'backend:plugin-review-bot',
      payload: expect.objectContaining({
        agentId: 'claude',
        runtimeTarget: {
          kind: 'backend',
          backendId: 'plugin-review-bot',
          sourceKind: 'built_in',
        },
      }),
    }));
  });

  it('spawns a V1 plugin target key with a distinct runtime descriptor Agent carrier', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-v1-plugin',
      session: { id: 'sess-v1-plugin' },
    });
    const runtimeDescriptorV1 = {
      v: 1 as const,
      agentId: 'claude',
      agent: {},
    };
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

    await expect(deps.sessionSpawnNew({
      backendTargetKey: 'agent:plugin-review-bot',
      runtimeDescriptorV1,
      path: '/repo',
    })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'sess-v1-plugin',
    });

    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'plugin-review-bot',
        sourceKind: 'built_in',
      },
      runtimeDescriptorV1,
    }));
    expect(emitSessionLifecycleHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: 'backend:plugin-review-bot',
      payload: expect.objectContaining({
        agentId: 'claude',
      }),
    }));
  });

  it('rejects a V1 plugin target key without an explicit runtime Agent carrier', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-v1-plugin-without-carrier',
      session: { id: 'sess-v1-plugin-without-carrier' },
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

    await expect(deps.sessionSpawnNew({
      backendTargetKey: 'agent:plugin-review-bot',
      path: '/repo',
    })).resolves.toMatchObject({
      type: 'error',
      errorCode: 'invalid_parameters',
    });

    expect(createSpawnedSession).not.toHaveBeenCalled();
    expect(emitSessionLifecycleHookEvent).not.toHaveBeenCalled();
  });

  it('spawns equivalent lossy V1 configured and lossless V2 structured targets', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-v1-v2-configured',
      session: { id: 'sess-v1-v2-configured' },
    });
    const backendTarget = {
      kind: 'backend' as const,
      backendId: 'customAcpRuntimeCarrier',
      configuredBackendId: 'kiro',
      sourceKind: 'configured' as const,
    };
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

    await expect(deps.sessionSpawnNew({
      backendTargetKey: 'acpBackend:kiro',
      backendTarget,
      path: '/repo',
    })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'sess-v1-v2-configured',
    });

    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget,
    }));
    expect(emitSessionLifecycleHookEvent).not.toHaveBeenCalled();
  });

  it('does not publish a structured non-Agent backend id without an explicit Agent carrier', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-structured-plugin',
      session: { id: 'sess-structured-plugin' },
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

    await expect(deps.sessionSpawnNew({
      backendTarget: {
        kind: 'backend',
        backendId: 'plugin-review-bot',
        sourceKind: 'built_in',
      },
      path: '/repo',
    })).resolves.toMatchObject({
      type: 'success',
      sessionId: 'sess-structured-plugin',
    });

    expect(createSpawnedSession).toHaveBeenCalledWith(expect.objectContaining({
      backendTarget: {
        kind: 'backend',
        backendId: 'plugin-review-bot',
        sourceKind: 'built_in',
      },
    }));
    expect(emitSessionLifecycleHookEvent).not.toHaveBeenCalled();
  });

  it.each([
    ['Agent id', { agentId: 'claude' }],
    ['runtime descriptor Agent', {
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'claude',
        agent: {},
      },
    }],
    ['backend target key', { backendTargetKey: 'agent:claude' }],
  ] as const)('rejects a structured built-in target that conflicts with an explicit %s', async (_label, conflictingInput) => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-conflicting-target',
      session: { id: 'sess-conflicting-target' },
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

    await expect(deps.sessionSpawnNew({
      backendTarget: {
        kind: 'backend',
        backendId: 'codex',
        sourceKind: 'built_in',
      },
      path: '/repo',
      ...conflictingInput,
    })).resolves.toMatchObject({
      type: 'error',
      errorCode: 'invalid_parameters',
    });

    expect(createSpawnedSession).not.toHaveBeenCalled();
    expect(emitSessionLifecycleHookEvent).not.toHaveBeenCalled();
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
      payload: {
        sessionId: 'sess-1',
        text: 'Hello world',
        source: 'user',
      },
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
      payload: {
        sessionId: 'sess-1',
        text: 'Hello world',
        source: 'user',
      },
    }));
  });

  it('dispatches session.message.send hooks with the resolved target session context', async () => {
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'sess-target',
      localId: 'local-target',
      waited: false,
    });
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-target',
      rawSession: {
        machineId: 'target-machine',
        path: '/repo/target',
        metadata: {
          workspaceId: 'target-workspace',
        },
      },
      mode: 'plain',
      ctx: {
        encryptionKey: new Uint8Array([5, 6, 7, 8]),
        encryptionVariant: 'legacy',
      },
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
        machineId: 'parent-machine',
        path: '/repo/parent',
        metadata: {
          workspaceId: 'parent-workspace',
        },
      },
      happyHomeDir: '/tmp/happier-home',
    });

    await expect(deps.sessionSendMessage({
      sessionId: 'sess-target',
      message: 'Hello target',
    })).resolves.toEqual({
      ok: true,
      sessionId: 'sess-target',
      localId: 'local-target',
      waited: false,
    });

    expect(resolveSessionTransportContext).toHaveBeenCalledWith(expect.objectContaining({
      idOrPrefix: 'sess-target',
    }));
    expect(emitSessionLifecycleHookEvent).toHaveBeenCalledWith(expect.objectContaining({
      happySessionId: 'sess-target',
      machineId: 'target-machine',
      cwd: '/repo/target',
      workspaceId: 'target-workspace',
      payload: {
        sessionId: 'sess-target',
        text: 'Hello target',
        source: 'user',
      },
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
      answers: [{ question: 'Continue?', values: ['Yes'] }],
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

  it('delegates inactive usage-limit wait-resume controls to the exact target daemon', async () => {
    callMachineRpc
      .mockResolvedValueOnce({ ok: true, status: 'waiting', sessionId: 'sess-remote' })
      .mockResolvedValueOnce({ ok: true, status: 'cancelled', sessionId: 'sess-remote' });
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
    });

    await expect(deps.sessionUsageLimitWaitResumeEnable?.({
      sessionId: 'sess-remote',
      issueFingerprint: 'usage-limit:sess-remote:reset',
      remember: true,
      resumePromptMode: 'off',
    })).resolves.toMatchObject({ ok: true, status: 'waiting', sessionId: 'sess-remote' });
    await expect(deps.sessionUsageLimitWaitResumeCancel?.({
      sessionId: 'sess-remote',
      issueFingerprint: 'usage-limit:sess-remote:reset',
      armedAtMs: 1,
      runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
    })).resolves.toEqual({ ok: true, status: 'cancelled', sessionId: 'sess-remote' });
    expect(callSessionRpc).not.toHaveBeenCalled();
    expect(callMachineRpc).toHaveBeenNthCalledWith(1, {
      credentials: expect.objectContaining({ token: 'token' }),
      machineId: 'target-machine',
      method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
      request: {
        sessionId: 'sess-remote',
        issueFingerprint: 'usage-limit:sess-remote:reset',
        rememberPreference: true,
        resumePromptMode: 'off',
      },
    });
    expect(callMachineRpc).toHaveBeenNthCalledWith(2, {
      credentials: expect.objectContaining({ token: 'token' }),
      machineId: 'target-machine',
      method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL,
      request: {
        sessionId: 'sess-remote',
        issueFingerprint: 'usage-limit:sess-remote:reset',
        armedAtMs: 1,
        runtimeAuthRecoveryAttemptId: 'runtime-auth-attempt:exact-1',
      },
    });
    expect(routeSessionUsageLimitRecoveryWaitResumeEnable).not.toHaveBeenCalled();
    expect(routeSessionUsageLimitRecoveryWaitResumeCancel).not.toHaveBeenCalled();
  });

  it('fails closed on inactive target-machine mismatch without opening a local owner', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-remote',
      rawSession: {
        id: 'sess-remote',
        active: false,
        machineId: 'machine-raw',
        metadata: { machineId: 'machine-metadata' },
      },
      ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
      mode: 'plain',
    });
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
      isUsageLimitRecoveryEnabled: async () => true,
    });

    await expect(deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess-remote' })).resolves.toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess-remote',
      errorCode: 'session_usage_limit_recovery_control_target_machine_mismatch',
    });
    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(routeSessionUsageLimitRecoveryCheckNow).not.toHaveBeenCalled();
  });

  it('reports an unavailable target daemon without falling back to local persistence', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-remote',
      rawSession: {
        id: 'sess-remote',
        active: false,
        machineId: 'target-machine',
        metadata: { machineId: 'target-machine' },
      },
      ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
      mode: 'plain',
    });
    callMachineRpc.mockRejectedValueOnce(new Error('daemon offline'));
    const deps = createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy', secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-current',
      mode: 'plain',
      ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
      isUsageLimitRecoveryEnabled: async () => true,
    });

    await expect(deps.sessionUsageLimitCheckNow?.({ sessionId: 'sess-remote' })).resolves.toEqual({
      ok: false,
      status: 'session_unreachable',
      sessionId: 'sess-remote',
      errorCode: 'session_usage_limit_recovery_control_target_machine_unavailable',
    });
    expect(routeSessionUsageLimitRecoveryCheckNow).not.toHaveBeenCalled();
  });

  it('keeps independent non-daemon action compositions as daemon-RPC delegates', async () => {
    resolveSessionTransportContext.mockResolvedValue({
      ok: true,
      sessionId: 'sess-remote',
      rawSession: {
        id: 'sess-remote',
        active: false,
        machineId: 'target-machine',
        metadata: { machineId: 'target-machine' },
      },
      ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' },
      mode: 'plain',
    });
    callMachineRpc.mockResolvedValue({ ok: true, status: 'waiting', sessionId: 'sess-remote' });
    const createDeps = () => createCliActionDeps({
      token: 'token',
      credentials: {
        token: 'token',
        encryption: { type: 'legacy' as const, secret: new Uint8Array([1, 2, 3, 4]) },
      },
      sessionId: 'sess-current',
      mode: 'plain' as const,
      ctx: { encryptionKey: new Uint8Array([1, 2, 3, 4]), encryptionVariant: 'legacy' as const },
      isUsageLimitRecoveryEnabled: async () => true,
    });

    await createDeps().sessionUsageLimitCheckNow?.({ sessionId: 'sess-remote' });
    await createDeps().sessionUsageLimitCheckNow?.({ sessionId: 'sess-remote' });

    expect(callMachineRpc).toHaveBeenCalledTimes(2);
    expect(routeSessionUsageLimitRecoveryCheckNow).not.toHaveBeenCalled();
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

  it('delegates inactive usage-limit check-now through daemon RPC when enabled', async () => {
    callMachineRpc.mockResolvedValueOnce({ ok: true, status: 'ready', sessionId: 'sess-remote' });
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

    await expect(deps.sessionUsageLimitCheckNow?.({
      sessionId: 'sess-remote',
      agentId: ' codex ',
    })).resolves.toEqual({ ok: true, status: 'ready', sessionId: 'sess-remote' });

    expect(callSessionRpc).not.toHaveBeenCalled();
    expect(callMachineRpc).toHaveBeenCalledWith({
      credentials: expect.objectContaining({ token: 'token' }),
      machineId: 'target-machine',
      method: RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
      request: { sessionId: 'sess-remote', agentId: 'codex' },
    });
    expect(routeSessionUsageLimitRecoveryCheckNow).not.toHaveBeenCalled();
  });

  it('keeps active usage-limit reset-credit consumption in runner SESSION RPC custody', async () => {
    callSessionRpc.mockResolvedValueOnce({ ok: true, status: 'waiting', sessionId: 'sess-remote' });
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

    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-remote',
      method: `sess-remote:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT}`,
      request: {
        sessionId: 'sess-remote',
        agentId: 'codex',
        operation: 'consume_reset_credit',
        resumePromptMode: 'custom',
      },
    }));
    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(routeSessionUsageLimitRecoveryCheckNow).not.toHaveBeenCalled();
  });

  it('keeps active usage-limit switch-account controls in runner SESSION RPC custody', async () => {
    callSessionRpc.mockResolvedValueOnce({ ok: true, status: 'waiting', sessionId: 'sess-group' });
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

    expect(callSessionRpc).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'sess-group',
      method: `sess-group:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW}`,
      request: {
        sessionId: 'sess-group',
        agentId: 'codex',
        operation: 'switch_account_now',
        resumePromptMode: 'custom',
      },
    }));
    expect(callMachineRpc).not.toHaveBeenCalled();
    expect(routeSessionUsageLimitRecoverySwitchAccountNow).not.toHaveBeenCalled();
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
