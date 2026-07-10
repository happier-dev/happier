import { beforeEach, describe, expect, it, vi } from 'vitest';

const { callSessionRpc } = vi.hoisted(() => ({
  callSessionRpc: vi.fn(),
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc,
}));

import type { HostRuntimeControlResultV1 } from '@happier-dev/agents';
import { createResolvedSessionRuntimeControlTransport } from './transport';

type SessionConnectedServiceAuthControls = Readonly<{
  applyConnectedServiceAuthGeneration: (
    input: Readonly<Record<string, unknown>>,
  ) => Promise<HostRuntimeControlResultV1<unknown>>;
  readConnectedServiceRuntimeIdentity: (
    input: Readonly<Record<string, unknown>>,
  ) => Promise<HostRuntimeControlResultV1<unknown>>;
}>;

function createTransport() {
  return createResolvedSessionRuntimeControlTransport({
    token: 'token-1',
    sessionId: 's1',
    mode: 'plain',
    ctx: {
      encryptionKey: new Uint8Array(32),
      encryptionVariant: 'dataKey',
    },
  }) as ReturnType<typeof createResolvedSessionRuntimeControlTransport> & SessionConnectedServiceAuthControls;
}

describe('createResolvedSessionRuntimeControlTransport', () => {
  beforeEach(() => {
    callSessionRpc.mockReset();
  });

  it('forwards connected-service auth apply and runtime identity RPCs', async () => {
    callSessionRpc
      .mockResolvedValueOnce({
        ok: true,
        appliedVia: 'direct_live_hot_auth',
        activeAccountId: 'acct_1',
      })
      .mockResolvedValueOnce({
        ok: true,
        serviceId: 'openai-codex',
        identity: {
          strategy: 'provider_account_id',
          proofStrength: 'exact',
          providerAccountId: 'acct_1',
        },
      });
    const transport = createTransport();

    await expect(transport.applyConnectedServiceAuthGeneration({
      serviceId: 'openai-codex',
      reason: 'usage_limit',
      authGeneration: { kind: 'oauth', providerAccountId: 'acct_1' },
    })).resolves.toEqual({
      ok: true,
      value: {
        ok: true,
        appliedVia: 'direct_live_hot_auth',
        activeAccountId: 'acct_1',
      },
    });
    await expect(transport.readConnectedServiceRuntimeIdentity({
      serviceId: 'openai-codex',
      reason: 'diagnostic',
    })).resolves.toEqual({
      ok: true,
      value: {
        ok: true,
        serviceId: 'openai-codex',
        identity: {
          strategy: 'provider_account_id',
          proofStrength: 'exact',
          providerAccountId: 'acct_1',
        },
      },
    });

    expect(callSessionRpc).toHaveBeenNthCalledWith(1, expect.objectContaining({
      token: 'token-1',
      sessionId: 's1',
      method: 's1:session.connectedServiceAuth.applyGeneration',
      request: {
        serviceId: 'openai-codex',
        reason: 'usage_limit',
        authGeneration: { kind: 'oauth', providerAccountId: 'acct_1' },
      },
    }));
    expect(callSessionRpc).toHaveBeenNthCalledWith(2, expect.objectContaining({
      token: 'token-1',
      sessionId: 's1',
      method: 's1:session.connectedServiceAuth.readRuntimeIdentity',
      request: {
        serviceId: 'openai-codex',
        reason: 'diagnostic',
      },
    }));
  });

  it('fails closed when connected-service auth RPC responses are malformed', async () => {
    callSessionRpc.mockResolvedValueOnce({ ok: true, activeAccountId: 'acct_1' });
    const transport = createTransport();

    await expect(transport.applyConnectedServiceAuthGeneration({
      serviceId: 'openai-codex',
      reason: 'usage_limit',
      authGeneration: { kind: 'oauth' },
    })).resolves.toEqual({
      ok: false,
      code: 'connected_service_auth_apply_failed',
      error: 'connected_service_auth_apply_failed',
      diagnostics: [{ code: 'connected_service_auth_apply_failed' }],
    });
  });
});
