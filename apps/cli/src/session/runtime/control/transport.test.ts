import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';
import { createSessionRecordFixture } from '@/testkit/backends/sessionFixtures';

const { callSessionRpc } = vi.hoisted(() => ({
  callSessionRpc: vi.fn(),
}));

vi.mock('@/session/transport/rpc/sessionRpc', () => ({
  callSessionRpc,
}));

import {
  createResolvedSessionConnectedServiceAuthTransport,
  createSessionConnectedServiceAuthTransport,
} from './transport';

function createTransport() {
  return createResolvedSessionConnectedServiceAuthTransport({
    token: 'token-1',
    sessionId: 's1',
    mode: 'plain',
    ctx: null,
  });
}

describe('createResolvedSessionConnectedServiceAuthTransport', () => {
  beforeEach(() => {
    callSessionRpc.mockReset();
    vi.restoreAllMocks();
  });

  it('invalidates connected-service auth for a plain Session with token-only credentials', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({
          id: 'session-plain-123',
          encryptionMode: 'plain',
          metadata: '{}',
          dataEncryptionKey: null,
        }),
      },
    } as never);
    callSessionRpc.mockResolvedValueOnce({ ok: true });
    const transport = createSessionConnectedServiceAuthTransport({
      credentials: {
        token: 'token-only',
        encryption: null,
      },
      sessionId: 'session-plain-123',
    });

    await expect(transport.invalidateConnectedServiceAuthTransports()).resolves.toEqual({
      ok: true,
      value: true,
    });
    expect(callSessionRpc).toHaveBeenCalledWith({
      token: 'token-only',
      sessionId: 'session-plain-123',
      ctx: null,
      mode: 'plain',
      method: 'session-plain-123:session.connectedServiceAuth.invalidateTransports',
      request: {},
    });
  });

  it('preserves typed material-unavailable failure for retained E2EE Session control', async () => {
    vi.spyOn(axios, 'get').mockResolvedValueOnce({
      status: 200,
      data: {
        session: createSessionRecordFixture({
          id: 'session-e2ee-123',
          encryptionMode: 'e2ee',
          metadata: 'retained-ciphertext',
          dataEncryptionKey: 'retained-data-key-envelope',
        }),
      },
    } as never);
    const transport = createSessionConnectedServiceAuthTransport({
      credentials: {
        token: 'token-only',
        encryption: null,
      },
      sessionId: 'session-e2ee-123',
    });

    await expect(transport.invalidateConnectedServiceAuthTransports()).resolves.toEqual({
      ok: false,
      code: 'encryption_material_unavailable',
      error: 'encryption_material_unavailable',
      diagnostics: [{ code: 'encryption_material_unavailable' }],
    });
    expect(callSessionRpc).not.toHaveBeenCalled();
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
      timeoutMs: 60_000,
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
    expect(callSessionRpc.mock.calls[1]?.[0]).not.toHaveProperty('timeoutMs');
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
