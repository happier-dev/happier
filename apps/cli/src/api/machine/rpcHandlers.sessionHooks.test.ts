import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FeaturesResponseSchema,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcActionExecutor } from '@/rpc/handlers/_actionDispatchAdapter';

import { registerMachineExternalSessionsRpcHandlers } from './rpcHandlers.externalSessions';

const codexAgent = {
  pluginId: 'happier.agent.codex',
  localId: 'codex',
} as const;

const sessionHookComposition = vi.hoisted(() => {
  const stop = vi.fn(async () => undefined);
  return {
    status: vi.fn(async () => ({
      ok: true as const,
      rows: [],
      nextCursor: null,
      diagnostics: [],
    })),
    hydrate: vi.fn(async () => undefined),
    disposeHost: vi.fn(async () => undefined),
    stop,
    startListener: vi.fn(async () => ({ stop })),
    reloadCallback: null as (() => void) | null,
  };
});

vi.mock('@/session/actions/externalSessions/pluginSessionHookManagementHost', () => ({
  createPluginSessionHookManagementHost: vi.fn((input: Readonly<{
    listener: Promise<unknown>;
  }>) => ({
    status: sessionHookComposition.status,
    install: vi.fn(),
    disable: vi.fn(),
    enable: vi.fn(),
    uninstall: vi.fn(),
    hydrate: vi.fn(async () => {
      await input.listener;
      await sessionHookComposition.hydrate();
    }),
    dispose: sessionHookComposition.disposeHost,
  })),
}));

vi.mock('@/plugins/runtime/hooks/session/qualifiedExternalSessionHookTransport', () => ({
  startQualifiedExternalSessionHookListener: sessionHookComposition.startListener,
}));

vi.mock('@/plugins/runtime/reload/singleton', () => ({
  pluginReloadController: {
    subscribe: vi.fn((callback: () => void) => {
      sessionHookComposition.reloadCallback = callback;
      return vi.fn();
    }),
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

function createRpcHandlerManager(): Readonly<{
  handlers: Map<string, (params: unknown) => Promise<unknown>>;
  registerHandler(method: string, handler: (params: unknown) => Promise<unknown>): void;
}> {
  const handlers = new Map<string, (params: unknown) => Promise<unknown>>();
  return {
    handlers,
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
}

describe('machine session-hook management RPC composition', () => {
  it('registers every A14 RPC through the existing ActionSpec registrar', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      result: {
        ok: true as const,
        rows: [],
        nextCursor: null,
        diagnostics: [],
      },
    }));
    const actionExecutor: RpcActionExecutor = {
      execute,
    };
    const rpcHandlerManager = createRpcHandlerManager();
    const registration = registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      actionExecutor,
    });

    const expectedMethods = [
      RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET,
      RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_INSTALL,
      RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_DISABLE,
      RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_ENABLE,
      RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_UNINSTALL,
    ] as const;

    expect(expectedMethods.every((method) => rpcHandlerManager.handlers.has(method))).toBe(true);
    await expect(rpcHandlerManager.handlers.get(
      RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET,
    )?.({
      machineId: 'machine-1',
      intent: 'passive_inventory',
      agent: codexAgent,
    })).resolves.toMatchObject({
      ok: true,
      rows: [],
    });
    expect(execute).toHaveBeenCalledWith(
      'plugins.sessionHooks.status.get',
      expect.objectContaining({ machineId: 'machine-1', intent: 'passive_inventory' }),
      expect.objectContaining({ surface: 'rpc' }),
    );

    await registration.dispose();
  });

  it('reaches the default management host when the daemon supplies its current machine id', async () => {
    const rpcHandlerManager = createRpcHandlerManager();
    const registration = registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      machineId: 'machine-1',
      getServerFeaturesSnapshot: () => ({
        status: 'ready',
        features: FeaturesResponseSchema.parse({
          features: {
            sessions: { enabled: true },
          },
        }),
      }),
    });

    await expect(rpcHandlerManager.handlers.get(
      RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET,
    )?.({
      machineId: 'machine-1',
      intent: 'passive_inventory',
      agent: codexAgent,
    })).resolves.toEqual({
      ok: true,
      rows: [],
      nextCursor: null,
      diagnostics: [],
    });
    expect(sessionHookComposition.status).toHaveBeenCalledWith({
      machineId: 'machine-1',
      intent: 'passive_inventory',
      agent: codexAgent,
      limit: 50,
    });

    await registration.dispose();
    expect(sessionHookComposition.stop).toHaveBeenCalledOnce();
  });

  it('does not start listener, ingress hydration, or principals while sessions.direct is disabled', async () => {
    vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', 'sessions.direct');
    sessionHookComposition.startListener.mockClear();
    sessionHookComposition.hydrate.mockClear();
    const rpcHandlerManager = createRpcHandlerManager();
    const registration = registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      machineId: 'machine-disabled',
      getServerFeaturesSnapshot: () => ({
        status: 'ready',
        features: FeaturesResponseSchema.parse({
          features: {
            sessions: { enabled: true },
          },
        }),
      }),
    });

    await Promise.resolve();
    expect(sessionHookComposition.startListener).not.toHaveBeenCalled();
    expect(sessionHookComposition.hydrate).not.toHaveBeenCalled();
    await expect(rpcHandlerManager.handlers.get(
      RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET,
    )?.({
      machineId: 'machine-disabled',
      intent: 'passive_inventory',
    })).resolves.toMatchObject({
      ok: false,
      diagnostic: { code: 'feature_disabled' },
    });

    await registration.dispose();
  });

  it('stops live admission before retaining a now-disabled sessions.direct lifecycle', async () => {
    sessionHookComposition.startListener.mockClear();
    sessionHookComposition.stop.mockClear();
    sessionHookComposition.disposeHost.mockClear();
    const registration = registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: createRpcHandlerManager() as never,
      machineId: 'machine-transition',
      getServerFeaturesSnapshot: () => ({
        status: 'ready',
        features: FeaturesResponseSchema.parse({
          features: {
            sessions: { enabled: true },
          },
        }),
      }),
    });
    await vi.waitFor(() => {
      expect(sessionHookComposition.startListener).toHaveBeenCalledOnce();
    });

    vi.stubEnv('HAPPIER_BUILD_FEATURES_DENY', 'sessions.direct');
    sessionHookComposition.reloadCallback?.();
    await vi.waitFor(() => {
      expect(sessionHookComposition.disposeHost).toHaveBeenCalledOnce();
      expect(sessionHookComposition.stop).toHaveBeenCalledOnce();
    });

    await registration.dispose();
  });

  it('clears a failed hydration pair and retries with a fresh listener-host pair', async () => {
    sessionHookComposition.startListener.mockClear();
    sessionHookComposition.stop.mockClear();
    sessionHookComposition.hydrate.mockReset();
    sessionHookComposition.hydrate
      .mockRejectedValueOnce(new Error('hydrate failed'))
      .mockResolvedValue(undefined);
    const rpcHandlerManager = createRpcHandlerManager();
    const registration = registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      machineId: 'machine-retry',
      getServerFeaturesSnapshot: () => ({
        status: 'ready',
        features: FeaturesResponseSchema.parse({
          features: {
            sessions: { enabled: true },
          },
        }),
      }),
    });
    await vi.waitFor(() => {
      expect(sessionHookComposition.stop).toHaveBeenCalledOnce();
    });

    await expect(rpcHandlerManager.handlers.get(
      RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET,
    )?.({
      machineId: 'machine-retry',
      intent: 'passive_inventory',
      agent: codexAgent,
    })).resolves.toMatchObject({ ok: true });
    expect(sessionHookComposition.startListener).toHaveBeenCalledTimes(2);

    await registration.dispose();
  });

  it('clears a rejected listener-start pair and retries with a fresh pair', async () => {
    sessionHookComposition.startListener.mockClear();
    sessionHookComposition.disposeHost.mockClear();
    sessionHookComposition.hydrate.mockReset();
    sessionHookComposition.hydrate.mockResolvedValue(undefined);
    sessionHookComposition.startListener
      .mockRejectedValueOnce(new Error('listener start failed'));
    const rpcHandlerManager = createRpcHandlerManager();
    const registration = registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: rpcHandlerManager as never,
      machineId: 'machine-listener-retry',
      getServerFeaturesSnapshot: () => ({
        status: 'ready',
        features: FeaturesResponseSchema.parse({
          features: {
            sessions: { enabled: true },
          },
        }),
      }),
    });
    await vi.waitFor(() => {
      expect(sessionHookComposition.disposeHost).toHaveBeenCalledOnce();
    });

    await expect(rpcHandlerManager.handlers.get(
      RPC_METHODS.DAEMON_PLUGIN_SESSION_HOOKS_STATUS_GET,
    )?.({
      machineId: 'machine-listener-retry',
      intent: 'passive_inventory',
      agent: codexAgent,
    })).resolves.toMatchObject({ ok: true });
    expect(sessionHookComposition.startListener).toHaveBeenCalledTimes(2);

    await registration.dispose();
  });
});
