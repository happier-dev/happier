import { describe, expect, it } from 'vitest';

import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol';

import { buildSessionRuntimeIssueV1 } from './issues.js';

describe('buildSessionRuntimeIssueV1', () => {
  it('builds normalized schema-valid primary-session runtime issues', () => {
    const usageLimit = {
      v: 1,
      resetAtMs: null,
      retryAfterMs: 60_000,
      quotaScope: 'account',
      recoverability: 'wait',
      limitCategory: 'usage_limit',
    } as const;

    const issue = buildSessionRuntimeIssueV1({
      code: ' opencode_session_retry ',
      source: 'usage_limit',
      occurredAt: 123.9,
      agentId: ' opencode ',
      agentTurnId: ' turn-1 ',
      sanitizedPreview: ` ${'x'.repeat(2_100)} `,
      usageLimit,
    });

    expect(issue).toEqual({
      v: 1,
      scope: 'primary_session',
      status: 'failed',
      code: 'opencode_session_retry',
      source: 'usage_limit',
      occurredAt: 123,
      agentId: 'opencode',
      agentTurnId: 'turn-1',
      sanitizedPreview: 'x'.repeat(2_000),
      usageLimit,
    });
    expect(SessionRuntimeIssueV1Schema.safeParse(issue).success).toBe(true);
  });
});
