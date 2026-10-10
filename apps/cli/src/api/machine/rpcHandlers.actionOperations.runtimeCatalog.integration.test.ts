import { describe, expect, it, vi } from 'vitest';

import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions';
import { createActionExecutor, type ActionExecutorDeps } from '@happier-dev/protocol/actions/actionExecutor';
import { MANAGED_MACHINE_ACTION_IDS_V1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createHostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import type { RpcHandler } from '@/api/rpc/types';

import { registerMachineRpcHandlers } from './rpcHandlers';

type Handler = (data: unknown) => Promise<unknown>;

function createRpcHandlerManager() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    registerHandler(method: string, handler: Handler) {
      handlers.set(method, handler);
    },
  };
}

describe('machine RPC Action operations', () => {
  it('installs finite RPCs only with the real runtime and refuses unavailable requester material', async () => {
    const manager = createRpcHandlerManager();
    const operations = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'account' });
    const registration = registerMachineRpcHandlers({ rpcHandlerManager: manager as never,
      handlers: { spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'unavailable' }) as never,
        stopSession: async () => true, requestShutdown() {} },
      deps: { currentMachineId: 'machine', currentServerId: 'home', actionOperations: operations,
        createProjectFiniteRuntime: async () => null },
    });
    const input = { workspace: { serverId: 'home', workspaceId: 'workspace', machineId: 'machine', rootPath: '/repo' }, phase: 'setup' };
    try {
      const handler = manager.handlers.get(PROJECT_FINITE_ACTION_RPC_METHODS_V1['projects.prepare']) as RpcHandler<unknown, unknown> | undefined;
      expect(handler).toBeDefined();
      expect(await handler?.(input, { signal: new AbortController().signal, transportRequestId: 'request',
        machineAdmission: { actorAccountId: 'account', custodianAccountId: 'account', machineId: 'machine',
          installationId: 'installation', role: 'manage', encryptionMode: 'plain' },
        verifyMachineAdmissionCurrent: async () => true,
      }))
        .toMatchObject({ ok: false, errorCode: 'project_finite_execution_unavailable' });
      expect(operations.store.list({ accountId: 'account', machineId: 'machine' }).items).toEqual([]);
    } finally { await registration.dispose(); }
  });
  it('exposes managed discovery and recovery through the incumbent spec registrar', async () => {
    const manager = createRpcHandlerManager();
    // The remote managed-resource response is the substituted network boundary.
    const executor = createActionExecutor({ managedMachineAction: async () => ({ provisioners: [] }) } as unknown as ActionExecutorDeps);
    const operations = createHostActionOperationRuntime({ machineId: 'controller', resolveAccountId: async () => 'account' });
    registerMachineRpcHandlers({ rpcHandlerManager: manager as never,
      handlers: { spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'unavailable' }) as never,
        stopSession: async () => true, requestShutdown() {} },
      deps: { currentMachineId: 'controller', actionOperations: operations,
        externalAction: { machineId: 'controller', currentServerId: 'home', resolveAccountId: async () => 'account',
          resolveInstallationId: () => 'installation', verifyExecutionAuthorization: async () => false,
          resolveTarget: async () => null, executor },
      },
    });
    for (const actionId of MANAGED_MACHINE_ACTION_IDS_V1) expect(manager.handlers.has(actionId)).toBe(true);
    expect(await manager.handlers.get('machines.provisioners.list')?.({ homeId: 'home' }))
      .toEqual({ provisioners: [] });
  });

  it('mounts every versioned Action operation method through the canonical machine registrar', () => {
    const manager = createRpcHandlerManager();
    const handlers = {
      list: vi.fn(),
      get: vi.fn(),
      cancel: vi.fn(),
    };

    registerMachineRpcHandlers({
      rpcHandlerManager: manager as never,
      handlers: {
        spawnSession: async () => ({ type: 'error', errorCode: 'unknown', errorMessage: 'not implemented' }) as never,
        stopSession: async () => true,
        requestShutdown: () => {},
      },
      deps: {
        actionOperations: {
          handlers,
          observeExecution: async ({ execute }) => await execute({
            signal: new AbortController().signal,
            operationProgress: { update: () => undefined },
            operationOwnerUpdate: { update: () => undefined },
          }),
        },
      },
    });

    expect([...manager.handlers.keys()]).toEqual(expect.arrayContaining(
      Object.values(ACTION_OPERATION_RPC_METHODS_V1),
    ));
    expect(manager.handlers.has('actionOperation.start.v1')).toBe(false);
    expect(manager.handlers.has('actionOperation.wait.v1')).toBe(false);
    expect(manager.handlers.get(ACTION_OPERATION_RPC_METHODS_V1.list)).toBe(handlers.list);
    expect(manager.handlers.get(ACTION_OPERATION_RPC_METHODS_V1.get)).toBe(handlers.get);
    expect(manager.handlers.get(ACTION_OPERATION_RPC_METHODS_V1.cancel)).toBe(handlers.cancel);
  });
});
