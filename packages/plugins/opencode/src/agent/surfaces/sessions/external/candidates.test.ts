import { describe, expect, it, vi } from 'vitest';

const openCodeClientMock = vi.hoisted(() => ({
  sessionList: vi.fn(),
  sessionStatusList: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('./client.js', () => ({
  createOpenCodeExternalSessionClient: vi.fn(async () => openCodeClientMock),
}));

import { listOpenCodeSessionCandidates } from './candidates.js';

describe('listOpenCodeSessionCandidates', () => {
  it('emits canonical runtimeDescriptorV1 candidate details', async () => {
    openCodeClientMock.sessionList.mockResolvedValueOnce([
      {
        id: 'oc-session-1',
        title: 'OpenCode session',
        updatedAtMs: 123,
      },
    ]);
    openCodeClientMock.sessionStatusList.mockResolvedValueOnce({});
    openCodeClientMock.dispose.mockResolvedValueOnce(undefined);

    const result = await listOpenCodeSessionCandidates({
      source: {
        kind: 'opencodeServer',
        baseUrl: 'http://127.0.0.1:49196/',
      },
      limit: 10,
    });

    expect(result.candidates).toHaveLength(1);
    const details = result.candidates[0]?.details;
    expect(details).toMatchObject({
      runtimeDescriptorV1: {
        v: 1,
        agentId: 'opencode',
        agent: {
          backendMode: 'server',
          providerSessionId: 'oc-session-1',
          agentExtra: {
            runtimeHandle: {
              backendMode: 'server',
              providerSessionId: 'oc-session-1',
              serverBaseUrl: 'http://127.0.0.1:49196/',
              serverBaseUrlExplicit: true,
            },
          },
        },
      },
    });
    expect(details).not.toHaveProperty('agentRuntimeDescriptorV1');
  });
});
