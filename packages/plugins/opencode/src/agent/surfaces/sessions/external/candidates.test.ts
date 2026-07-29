import { afterEach, describe, expect, it, vi } from 'vitest';

const openCodeClientMock = vi.hoisted(() => ({
  sessionList: vi.fn(),
  sessionStatusList: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('./client.js', () => ({
  createOpenCodeExternalSessionClient: vi.fn(async () => openCodeClientMock),
}));

import {
  listOpenCodeSessionCandidates,
  parseOpenCodeSessionCandidate,
} from './candidates.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listOpenCodeSessionCandidates', () => {
  it('reads the official OpenCode nested session update timestamp', () => {
    expect(parseOpenCodeSessionCandidate({
      id: 'oc-session-time',
      title: 'Timestamp fixture',
      time: {
        created: 1_700_000_000_000,
        updated: 1_700_000_123_456,
      },
    })).toMatchObject({
      remoteSessionId: 'oc-session-time',
      updatedAtMs: 1_700_000_123_456,
    });
  });

  it('emits canonical runtimeDescriptorV1 candidate details', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-24T00:00:00.000Z'));
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
    expect(result.candidates[0]?.activity).toBe('idle');
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
