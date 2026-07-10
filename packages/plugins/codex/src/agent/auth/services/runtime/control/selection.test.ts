import { describe, expect, it, vi } from 'vitest';

import type { HostRuntimeControlServiceV1 } from '@happier-dev/plugin-sdk/experimental/runtime/session';

import { materializeCodexConnectedServiceRuntimeAuthSelection } from './selection.js';

describe('Codex runtime auth selection materializer', () => {
  it('exposes an anticipated direct runtime apply hook without requiring transport recycle controls', async () => {
    const applyConnectedServiceAuthGeneration = vi.fn(async (request: unknown) => ({
      ok: true,
      value: {
        ok: true,
        appliedVia: 'direct_live_hot_auth',
        request,
      },
    }));
    const checkAppServerAvailable = vi.fn(async () => ({
      ok: false as const,
      code: 'app_server_control_unavailable',
      error: 'app_server_control_unavailable',
    }));
    const checkTransportInvalidation = vi.fn(async () => ({
      ok: false as const,
      code: 'session_transport_unavailable',
      error: 'session_transport_unavailable',
    }));

    const selection = await materializeCodexConnectedServiceRuntimeAuthSelection({
      runtimeControl: {
        context: { metadata: {} },
        appServer: {
          checkAvailable: checkAppServerAvailable,
          request: vi.fn(),
        },
        session: {
          applyConnectedServiceAuthGeneration,
          checkConnectedServiceAuthTransportInvalidation: checkTransportInvalidation,
          invalidateConnectedServiceAuthTransports: vi.fn(),
        },
      } as unknown as HostRuntimeControlServiceV1,
      params: {
        input: { serviceId: 'openai-codex' },
        baseSelection: {
          serviceId: 'openai-codex',
          profileId: 'work',
        },
      },
    });

    expect(selection).toMatchObject({
      serviceId: 'openai-codex',
      applyConnectedServiceAuthGeneration: expect.any(Function),
    });
    expect(selection).not.toMatchObject({
      client: expect.anything(),
      invalidateTransports: expect.anything(),
    });
    await expect((selection as {
      applyConnectedServiceAuthGeneration(request: unknown): Promise<unknown>;
    }).applyConnectedServiceAuthGeneration({ serviceId: 'openai-codex' })).resolves.toEqual({
      ok: true,
      appliedVia: 'direct_live_hot_auth',
      request: { serviceId: 'openai-codex' },
    });
    expect(applyConnectedServiceAuthGeneration).toHaveBeenCalledWith({ serviceId: 'openai-codex' });
    expect(checkAppServerAvailable).not.toHaveBeenCalled();
    expect(checkTransportInvalidation).not.toHaveBeenCalled();
  });
});
