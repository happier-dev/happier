import { describe, expect, it } from 'vitest';

import {
  AgentSessionAuthRefreshClassificationV1Schema,
  AgentSessionAuthRefreshErrorV1Schema,
  normalizeAgentSessionAuthRefreshErrorV1,
  ProviderTranscriptDispatchRequestV1Schema,
} from './authRefresh';

describe('bounded runtime authentication and transcript-dispatch contracts', () => {
  it('accepts portable JSON and rejects cyclic or executable payloads', () => {
    expect(ProviderTranscriptDispatchRequestV1Schema.parse({
      body: { type: 'message', parts: ['hello'] },
      meta: { attempt: 1 },
    })).toEqual({
      body: { type: 'message', parts: ['hello'] },
      meta: { attempt: 1 },
    });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(ProviderTranscriptDispatchRequestV1Schema.safeParse({ body: cyclic }).success)
      .toBe(false);
    expect(ProviderTranscriptDispatchRequestV1Schema.safeParse({ body: () => undefined }).success)
      .toBe(false);
  });

  it('requires classifications to be bounded JSON objects', () => {
    expect(AgentSessionAuthRefreshClassificationV1Schema.parse({
      serviceId: 'openai-codex',
      connectedServiceRecovery: 'available',
    })).toEqual({
      serviceId: 'openai-codex',
      connectedServiceRecovery: 'available',
    });
    expect(AgentSessionAuthRefreshClassificationV1Schema.safeParse(['not', 'an', 'object']).success)
      .toBe(false);
  });

  it('normalizes thrown values into the named error contract', () => {
    const error = Object.assign(new Error('refresh failed'), { code: 'credential_expired' });
    expect(normalizeAgentSessionAuthRefreshErrorV1(error)).toEqual({
      name: 'Error',
      message: 'refresh failed',
      code: 'credential_expired',
    });
    expect(AgentSessionAuthRefreshErrorV1Schema.safeParse({
      message: 'failed',
      stack: 'private implementation detail',
    }).success).toBe(false);
  });
});
