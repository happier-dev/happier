import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';

const mocks = vi.hoisted(() => ({
  createExecutor: vi.fn(),
  readCredentials: vi.fn(),
  readStoredCredentials: vi.fn(),
}));

vi.mock('@/persistence', () => ({
  readCredentials: mocks.readCredentials,
  readStoredCredentials: mocks.readStoredCredentials,
}));

vi.mock('@/session/actions/createCliActionExecutorFromCredentials', () => ({
  createCliActionExecutorFromCredentials: mocks.createExecutor,
}));

import { registerApprovalRpcHandlers } from './approvals';
import { registerSessionPermissionRpcHandlers } from './sessionPermissions';
import { registerSessionSpawnNewRpcHandlers } from './sessionLifecycle';
import { registerSubagentRpcHandlers } from './subagents';

function createRegistrar() {
  const handlers = new Map<string, RpcHandler>();
  const rpcHandlerManager: RpcHandlerRegistrar = {
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
  return {
    handlers,
    rpcHandlerManager,
  };
}

describe('plain-account RPC action ingress', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readCredentials.mockResolvedValue(null);
    mocks.readStoredCredentials.mockResolvedValue({
      token: 'token-only',
      encryption: null,
    });
    mocks.createExecutor.mockReturnValue({
      execute: async (actionId: string) => ({
        ok: true,
        result: { actionId },
      }),
    });
  });

  it.each([
    {
      name: 'approvals',
      method: RPC_METHODS.APPROVAL_REQUEST_LIST,
      register: (rpcHandlerManager: ReturnType<typeof createRegistrar>['rpcHandlerManager']) =>
        registerApprovalRpcHandlers({ rpcHandlerManager }),
    },
    {
      name: 'permissions',
      method: RPC_METHODS.SESSION_PERMISSION_RESPOND,
      register: (rpcHandlerManager: ReturnType<typeof createRegistrar>['rpcHandlerManager']) =>
        registerSessionPermissionRpcHandlers({ rpcHandlerManager }),
    },
    {
      name: 'subagents',
      method: RPC_METHODS.SESSIONS_SUBAGENTS_LIST,
      register: (rpcHandlerManager: ReturnType<typeof createRegistrar>['rpcHandlerManager']) =>
        registerSubagentRpcHandlers({ rpcHandlerManager }),
    },
    {
      name: 'session creation',
      method: RPC_METHODS.SESSION_SPAWN_NEW,
      input: {
        creationKey: 'manual:stored-credentials-1',
        executionTarget: { serverId: 'server-1', machineId: 'machine-1' },
        directory: '/tmp/project',
        organizationPlacement: { folderId: null, tagIds: [] },
        agentTarget: {
          kind: 'agent',
          identity: { pluginId: 'happier.agent.codex', localId: 'codex' },
        },
      },
      register: (rpcHandlerManager: ReturnType<typeof createRegistrar>['rpcHandlerManager']) =>
        registerSessionSpawnNewRpcHandlers({ rpcHandlerManager }),
    },
  ])('uses token-only stored credentials for $name actions', async ({ method, input, register }) => {
    const { handlers, rpcHandlerManager } = createRegistrar();
    register(rpcHandlerManager);

    await expect(handlers.get(method)?.(input ?? {})).resolves.toBeDefined();
    expect(mocks.createExecutor).toHaveBeenCalledWith(expect.objectContaining({
      credentials: {
        token: 'token-only',
        encryption: null,
      },
    }));
    expect(mocks.readCredentials).not.toHaveBeenCalled();
  });
});
