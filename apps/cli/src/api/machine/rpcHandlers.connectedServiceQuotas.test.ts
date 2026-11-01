import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerRegistrar } from '../rpc/types';
import { registerMachineConnectedServiceQuotaRpcHandlers } from './rpcHandlers.connectedServiceQuotas';

const notifyDaemonConnectedServiceQuotaRecoveryCreditConsume = vi.hoisted(() => vi.fn());

vi.mock('@/daemon/controlClient', () => ({
  notifyDaemonConnectedServiceQuotaRecoveryCreditConsume,
}));

describe('registerMachineConnectedServiceQuotaRpcHandlers', () => {
  let handlers: Map<string, (raw: unknown) => Promise<unknown>>;

  beforeEach(() => {
    handlers = new Map();
    notifyDaemonConnectedServiceQuotaRecoveryCreditConsume.mockReset();
  });

  async function registerHandlers() {
    registerMachineConnectedServiceQuotaRpcHandlers({
      rpcHandlerManager: {
        registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
          handlers.set(method, async (raw: unknown) => await handler(raw as TRequest));
        },
      } satisfies RpcHandlerRegistrar,
    });
  }

  it.each(['openai-codex', 'happier.agent.codex/openai-codex'])('dispatches %s recovery-credit consume requests through the qualified daemon control path', async (serviceId) => {
    await registerHandlers();
    notifyDaemonConnectedServiceQuotaRecoveryCreditConsume.mockResolvedValueOnce({
      ok: true,
      result: {
        ok: true,
        receipt: {
          idempotencyKey: 'consume:session-1:credit-1',
          providerCreditId: 'credit-1',
          status: 'consumed',
        },
        snapshot: {
          v: 1,
          serviceId: 'openai-codex',
          profileId: 'work',
          fetchedAt: 1_000,
          staleAfterMs: 300_000,
          planLabel: null,
          accountLabel: null,
          meters: [],
        },
      },
    });

    const handler = handlers.get(RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME);
    await expect(handler?.({
      serviceId,
      profileId: 'work',
      idempotencyKey: 'consume:session-1:credit-1',
      providerCreditId: 'credit-1',
    })).resolves.toEqual({
      ok: true,
      receipt: {
        idempotencyKey: 'consume:session-1:credit-1',
        providerCreditId: 'credit-1',
        status: 'consumed',
      },
      snapshot: expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'work',
      }),
    });

    expect(notifyDaemonConnectedServiceQuotaRecoveryCreditConsume).toHaveBeenCalledWith({
      serviceId: 'happier.agent.codex/openai-codex',
      profileId: 'work',
      idempotencyKey: 'consume:session-1:credit-1',
      providerCreditId: 'credit-1',
    });
  });

  it('rejects an empty profile even with valid idempotency before daemon dispatch', async () => {
    await registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME);

    await expect(handler?.({
      serviceId: 'openai-codex', profileId: '', idempotencyKey: 'consume:invalid-profile',
    })).resolves.toEqual({
      ok: false,
      error: 'invalid_parameters',
      errorCode: 'invalid_parameters',
    });
    expect(notifyDaemonConnectedServiceQuotaRecoveryCreditConsume).not.toHaveBeenCalled();
  });

  it('rejects consume requests without idempotency before daemon dispatch', async () => {
    await registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME);

    await expect(handler?.({ serviceId: 'openai-codex', profileId: 'work' })).resolves.toEqual({
      ok: false,
      error: 'invalid_parameters',
      errorCode: 'invalid_parameters',
    });
    expect(notifyDaemonConnectedServiceQuotaRecoveryCreditConsume).not.toHaveBeenCalled();
  });
});
