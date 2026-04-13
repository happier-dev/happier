import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  createSpawnedSession,
  sendSessionMessage,
  createCliApprovalsArtifactStore,
  resolveExecutablePluginRuntimeRegistry,
  dispatchPluginHookEvent,
} = vi.hoisted(() => ({
  createSpawnedSession: vi.fn(),
  sendSessionMessage: vi.fn(),
  createCliApprovalsArtifactStore: vi.fn(() => ({})),
  resolveExecutablePluginRuntimeRegistry: vi.fn(),
  dispatchPluginHookEvent: vi.fn(),
}));

vi.mock('@/session/services/createSpawnedSession', () => ({
  createSpawnedSession,
}));

vi.mock('@/session/services/sendSessionMessage', () => ({
  sendSessionMessage,
}));

vi.mock('@/approvals/cliApprovalsArtifactStore', () => ({
  createCliApprovalsArtifactStore,
}));

vi.mock('@/extensions/runtime/resolveExecutablePluginRuntimeRegistry', () => ({
  resolveExecutablePluginRuntimeRegistry,
}));

vi.mock('@/extensions/hooks/execution/dispatchPluginHookEvent', () => ({
  dispatchPluginHookEvent,
}));

import { createCliActionDeps } from './createCliActionDeps';

describe('createCliActionDeps hook dispatch', () => {
  beforeEach(() => {
    createSpawnedSession.mockReset();
    sendSessionMessage.mockReset();
    createCliApprovalsArtifactStore.mockReset();
    resolveExecutablePluginRuntimeRegistry.mockReset();
    dispatchPluginHookEvent.mockReset();

    resolveExecutablePluginRuntimeRegistry.mockResolvedValue({
      contributions: {
        hookRegistrations: [],
      },
      hookHandlersByHookId: new Map(),
      pluginDiagnosticsByPluginId: {},
      readHookEventEnvelopeV1: vi.fn(),
    });
  });

  it('dispatches a session.spawn_new hook event after a successful spawn', async () => {
    createSpawnedSession.mockResolvedValue({
      created: true,
      sessionId: 'sess-new',
      session: { id: 'sess-new' },
    });
    dispatchPluginHookEvent.mockResolvedValue({
      eventId: 'session.spawn_new',
      matchedHandlerCount: 0,
      outcomes: [],
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
        kind: 'builtInAgent',
        agentId: 'claude',
      },
      tag: 'tag-1',
      title: 'My title',
      initialMessage: 'Hello from spawn',
      modelId: 'gpt-4o',
    }));
    expect(resolveExecutablePluginRuntimeRegistry).toHaveBeenCalledTimes(1);
    expect(dispatchPluginHookEvent).toHaveBeenCalledWith({
      runtimeRegistry: expect.objectContaining({
        hookHandlersByHookId: expect.any(Map),
      }),
      event: expect.objectContaining({
        eventId: 'session.spawn_new',
        category: 'lifecycle',
        scope: 'session',
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
      }),
    });
  });

  it('dispatches a session.message.send hook event after a successful send', async () => {
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      localId: 'local-1',
      waited: false,
    });
    dispatchPluginHookEvent.mockResolvedValue({
      eventId: 'session.message.send',
      matchedHandlerCount: 0,
      outcomes: [],
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
    expect(resolveExecutablePluginRuntimeRegistry).toHaveBeenCalledTimes(1);
    expect(dispatchPluginHookEvent).toHaveBeenCalledWith({
      runtimeRegistry: expect.objectContaining({
        hookHandlersByHookId: expect.any(Map),
      }),
      event: expect.objectContaining({
        eventId: 'session.message.send',
        category: 'lifecycle',
        scope: 'session',
        happySessionId: 'sess-1',
        machineId: 'machine-1',
        cwd: '/repo',
        payload: expect.objectContaining({
          sessionId: 'sess-1',
          messageLength: 11,
          wait: true,
          timeoutSeconds: 30,
          permissionModeOverride: 'read_only',
          modelOverride: 'gpt-4o',
        }),
      }),
    });
  });

  it('dispatches session.message.send hooks with the resolved canonical session id when invoked by prefix', async () => {
    sendSessionMessage.mockResolvedValue({
      ok: true,
      sessionId: 'sess-1',
      localId: 'local-1',
      waited: false,
    });
    dispatchPluginHookEvent.mockResolvedValue({
      eventId: 'session.message.send',
      matchedHandlerCount: 0,
      outcomes: [],
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
    expect(dispatchPluginHookEvent).toHaveBeenCalledWith({
      runtimeRegistry: expect.objectContaining({
        hookHandlersByHookId: expect.any(Map),
      }),
      event: expect.objectContaining({
        eventId: 'session.message.send',
        category: 'lifecycle',
        scope: 'session',
        happySessionId: 'sess-1',
        payload: expect.objectContaining({
          sessionId: 'sess-1',
          messageLength: 11,
          wait: false,
          timeoutSeconds: 15,
        }),
      }),
    });
  });
});
