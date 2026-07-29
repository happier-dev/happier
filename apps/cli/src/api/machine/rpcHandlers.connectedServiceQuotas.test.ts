import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import type { RpcHandler, RpcHandlerRegistrar } from '../rpc/types';

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
    const { registerMachineConnectedServiceQuotaRpcHandlers } = await import('./rpcHandlers.connectedServiceQuotas');
    registerMachineConnectedServiceQuotaRpcHandlers({
      rpcHandlerManager: {
        registerHandler: <TRequest, TResponse>(method: string, handler: RpcHandler<TRequest, TResponse>) => {
          handlers.set(method, async (raw: unknown) => await handler(raw as TRequest));
        },
      } satisfies RpcHandlerRegistrar,
    });
  }

  it('dispatches recovery-credit consume requests to the daemon control path', async () => {
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
      serviceId: 'openai-codex',
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
      serviceId: 'openai-codex',
      profileId: 'work',
      idempotencyKey: 'consume:session-1:credit-1',
      providerCreditId: 'credit-1',
    });
  });

  it('returns stable invalid-parameter errors before daemon dispatch', async () => {
    await registerHandlers();
    const handler = handlers.get(RPC_METHODS.DAEMON_CONNECTED_SERVICE_QUOTA_RECOVERY_CREDIT_CONSUME);

    await expect(handler?.({ serviceId: 'not-real', profileId: '' })).resolves.toEqual({
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
