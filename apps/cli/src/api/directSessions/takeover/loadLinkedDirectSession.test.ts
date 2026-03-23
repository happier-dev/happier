import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchSessionByIdMock = vi.fn();
const tryDecryptSessionMetadataMock = vi.fn();

vi.mock('@/session/transport/http/sessionsHttp', () => ({
  fetchSessionById: (...args: unknown[]) => fetchSessionByIdMock(...args),
}));

vi.mock('@/session/transport/encryption/sessionEncryptionContext', () => ({
  tryDecryptSessionMetadata: (...args: unknown[]) => tryDecryptSessionMetadataMock(...args),
}));

import { loadLinkedDirectSession } from './loadLinkedDirectSession';

describe('loadLinkedDirectSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefers the nested OpenCode runtime descriptor over stale legacy metadata', async () => {
    fetchSessionByIdMock.mockResolvedValueOnce({ id: 'sess_1' });
    tryDecryptSessionMetadataMock.mockReturnValueOnce({
      path: '/repo',
      flavor: 'opencode',
      opencodeSessionId: 'legacy-session',
      opencodeBackendMode: 'acp',
      directSessionV1: {
        v: 1,
        providerId: 'opencode',
        machineId: 'machine_1',
        remoteSessionId: 'legacy-session',
        source: { kind: 'opencodeServer', baseUrl: 'http://127.0.0.1:4096/' },
        linkedAtMs: 1,
        agentRuntimeDescriptorV1: {
          v: 1,
          providerId: 'opencode',
          provider: {
            backendMode: 'server',
            vendorSessionId: 'runtime-session',
            serverBaseUrl: 'http://127.0.0.1:4096/',
            serverBaseUrlExplicit: true,
            providerExtra: {
              owner: 'opencode',
              schemaId: 'opencode.agentRuntimeDescriptorExtra',
              v: 1,
              runtimeHandle: {
                backendMode: 'server',
                vendorSessionId: 'runtime-session',
                serverBaseUrl: 'http://127.0.0.1:4096/',
                serverBaseUrlExplicit: true,
              },
            },
          },
        },
      },
    });

    const result = await loadLinkedDirectSession({
      credentials: { token: 'token', encryption: { type: 'legacy', secret: new Uint8Array([1]) } },
      sessionId: 'sess_1',
    });

    expect(result).toEqual({
      ok: true,
      session: expect.objectContaining({
        providerId: 'opencode',
        remoteSessionId: 'runtime-session',
      }),
    });
  });
});
