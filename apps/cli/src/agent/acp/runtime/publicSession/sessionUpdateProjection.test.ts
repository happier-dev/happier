import { describe, expect, it } from 'vitest';
import type { AgentAcpRuntimeDefinition } from '@happier-dev/plugin-sdk/agents/runtime';

import { projectAcpSessionUpdate } from './sessionUpdateProjection';

type UpdateCodec = NonNullable<AgentAcpRuntimeDefinition['sessionUpdates']>;

describe('projectAcpSessionUpdate retry ingress', () => {
  it.each([
    { attempt: 0, reason: 'unknown' },
    { attempt: 1.5, reason: 'unknown' },
    { attempt: Number.MAX_SAFE_INTEGER + 1, reason: 'unknown' },
    { attempt: 1, reason: 'future' },
    { attempt: 1, reason: 'unknown', message: 'private provider detail' },
  ])('drops malformed retry evidence while preserving the diagnostic (%j)', retry => {
    // Installed JavaScript plugin code is an untyped external boundary.
    const codec = { project: () => ({ retry, diagnostic: { code: 'provider_recovery', severity: 'info' } }) } as unknown as UpdateCodec;
    expect(projectAcpSessionUpdate(codec, { sessionUpdate: 'session_info_update' })).toEqual({
      diagnostic: { code: 'provider_recovery', severity: 'info' },
    });
  });

  it('admits the canonical retry fact and explicit clear without changing their meaning', () => {
    const retry = { attempt: 2, reason: 'rate_limited' as const };
    expect(projectAcpSessionUpdate({ project: () => ({ retry }) }, {})).toEqual({ retry });
    expect(projectAcpSessionUpdate({ project: () => ({ retry: null }) }, {})).toEqual({ retry: null });
  });
});
