import {
  EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1,
  type ExternalActionDaemonDispatchRequestV1,
} from '@happier-dev/protocol';
import {
  ACTION_API_SERVER_ORIGIN,
  isSocketRpcActionApiServerOriginAuthorizationContext,
} from '@happier-dev/protocol/rpc';
import { describe, expect, it, vi } from 'vitest';

import type { RpcHandler, RpcHandlerContext, RpcHandlerRegistrar } from '@/api/rpc/types';

import {
  registerExternalActionRpcHandler,
} from './externalAction';
import type {
  ExternalActionExecutor,
  ResolveExternalActionTarget,
} from '@/daemon/externalActions/executeExternalAction';

function registerHandlerForTest() {
  const handlers = new Map<string, RpcHandler>();
  const registrar: RpcHandlerRegistrar = {
    registerHandler(method, handler) {
      handlers.set(method, handler);
    },
  };
  return { handlers, registrar };
}

describe('registerExternalActionRpcHandler', () => {
  it('admits only the server-stamped exact-machine dispatch into the canonical ingress', async () => {
    const { handlers, registrar } = registerHandlerForTest();
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async () => (
      { kind: 'machine', machineId: 'machine-1' }
    ));
    const execute = vi.fn<ExternalActionExecutor['execute']>(async () => (
      { ok: true, result: { sessionId: 'session-1' } }
    ));
    const executor = { execute } satisfies ExternalActionExecutor;
    registerExternalActionRpcHandler(registrar, {
      machineId: 'machine-1',
      currentServerId: 'server-reserved-rpc',
      resolveAccountId: async () => 'account-1',
      resolveTarget,
      executor,
    });
    const handler = handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1);
    expect(handler).toBeDefined();

    const signal = new AbortController().signal;
    expect(isSocketRpcActionApiServerOriginAuthorizationContext(ACTION_API_SERVER_ORIGIN)).toBe(true);
    const request: ExternalActionDaemonDispatchRequestV1 = {
      actionId: 'session.spawn_new',
      envelope: {
        v: 1,
        requestId: 'request-1',
        target: { kind: 'machine', machineId: 'machine-1' },
        input: { sessionId: 'session-1' },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      placement: {
        machineId: 'machine-1',
        target: { kind: 'machine', machineId: 'machine-1' },
      },
    };
    await expect(handler?.(request, {
      authorization: ACTION_API_SERVER_ORIGIN,
      signal,
    })).resolves.toEqual({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'session.spawn_new',
        requestId: 'request-1',
        execution: { ok: true, result: { sessionId: 'session-1' } },
      },
    });
    expect(resolveTarget).toHaveBeenCalledWith(expect.objectContaining({
      actionId: 'session.spawn_new',
      currentMachineId: 'machine-1',
      signal,
    }));
    expect(executor.execute).toHaveBeenCalledWith('session.spawn_new', { sessionId: 'session-1' }, expect.objectContaining({
      surface: 'api',
      authority: 'account_automation',
      serverId: 'server-reserved-rpc',
      signal,
    }));
  });

  it('preserves a verified Session envelope target through the reserved server-origin ingress', async () => {
    const { handlers, registrar } = registerHandlerForTest();
    const resolveTarget = vi.fn<ResolveExternalActionTarget>(async ({ target }) => target ?? null);
    const execute = vi.fn<ExternalActionExecutor['execute']>(async () => (
      { ok: true, result: { invoked: true } }
    ));
    registerExternalActionRpcHandler(registrar, {
      machineId: 'machine-1',
      currentServerId: 'server-reserved-rpc',
      resolveAccountId: async () => 'account-1',
      resolveTarget,
      executor: { execute },
    });
    const signal = new AbortController().signal;
    const request: ExternalActionDaemonDispatchRequestV1 = {
      actionId: 'action.invoke',
      envelope: {
        v: 1,
        target: { kind: 'session', sessionId: 'session-1' },
        input: {
          action: { pluginId: 'acme.external', localId: 'inspect' },
          input: { sessionId: 'nested-plugin-payload' },
        },
      },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      placement: {
        machineId: 'machine-1',
        target: { kind: 'machine', machineId: 'machine-1' },
      },
    };

    await expect(handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)?.(request, {
      authorization: ACTION_API_SERVER_ORIGIN,
      signal,
    })).resolves.toEqual({
      kind: 'response',
      response: {
        v: 1,
        actionId: 'action.invoke',
        execution: { ok: true, result: { invoked: true } },
      },
    });

    expect(resolveTarget).toHaveBeenCalledWith({
      actionId: 'action.invoke',
      target: { kind: 'session', sessionId: 'session-1' },
      currentMachineId: 'machine-1',
      signal,
    });
    expect(execute).toHaveBeenCalledWith(
      'action.invoke',
      request.envelope.input,
      expect.objectContaining({
        surface: 'api',
        authority: 'account_automation',
        defaultSessionId: 'session-1',
        externalActionTarget: { kind: 'session', sessionId: 'session-1' },
        signal,
      }),
    );
  });

  it.each([
    undefined,
    { kind: 'action.api.serverOrigin', forged: true },
    { kind: 'session.serverStart.serverOrigin' },
  ])('rejects a missing or forged server-origin stamp', async (authorization) => {
    const { handlers, registrar } = registerHandlerForTest();
    const execute = vi.fn<ExternalActionExecutor['execute']>();
    const executor = { execute } satisfies ExternalActionExecutor;
    registerExternalActionRpcHandler(registrar, {
      machineId: 'machine-1',
      currentServerId: 'server-reserved-rpc',
      resolveAccountId: async () => 'account-1',
      resolveTarget: async () => ({ kind: 'machine', machineId: 'machine-1' }),
      executor,
    });
    const request: ExternalActionDaemonDispatchRequestV1 = {
      actionId: 'session.spawn_new',
      envelope: { v: 1, input: { sessionId: 'session-1' } },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      placement: {
        machineId: 'machine-1',
        target: { kind: 'machine', machineId: 'machine-1' },
      },
    };
    const response = await handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)?.(request, {
      signal: new AbortController().signal,
      ...(authorization ? {
        // This negative fixture deliberately crosses the typed registrar
        // boundary so the receiver's runtime authorization check is exercised.
        authorization: authorization as unknown as NonNullable<RpcHandlerContext['authorization']>,
      } : {}),
    });

    expect(response).toEqual({ error: 'Forbidden', errorCode: 'RPC_FORBIDDEN' });
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it('preserves an opaque server action id until canonical external ingress rejects it', async () => {
    const { handlers, registrar } = registerHandlerForTest();
    const resolveTarget = vi.fn<ResolveExternalActionTarget>();
    const execute = vi.fn<ExternalActionExecutor['execute']>();
    const executor = { execute } satisfies ExternalActionExecutor;
    registerExternalActionRpcHandler(registrar, {
      machineId: 'machine-1',
      currentServerId: 'server-reserved-rpc',
      resolveAccountId: async () => 'account-1',
      resolveTarget,
      executor,
    });

    await expect(handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)?.({
      actionId: 'not-a-public-action',
      envelope: { v: 1, input: {} },
      principal: {
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        authority: 'account_automation',
      },
      placement: {
        machineId: 'machine-1',
        target: { kind: 'machine', machineId: 'machine-1' },
      },
    }, {
      authorization: ACTION_API_SERVER_ORIGIN,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: 'invalid_request',
      errorCode: 'invalid_action',
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
