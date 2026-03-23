import { describe, expect, it } from 'vitest';

import { deriveActivitySummaryFromAgentState } from './deriveActivitySummaryFromAgentState';

describe('deriveActivitySummaryFromAgentState', () => {
  it('counts unresolved permission and user-action requests separately', () => {
    expect(deriveActivitySummaryFromAgentState({
      requests: {
        req_permission: {
          tool: 'Write',
          arguments: { path: '/tmp/a.ts' },
          createdAt: 1,
        },
        req_action: {
          tool: 'AskUserQuestion',
          kind: 'user_action',
          arguments: { question: 'Ship it?' },
          createdAt: 2,
        },
        req_completed: {
          tool: 'Write',
          arguments: { path: '/tmp/b.ts' },
          createdAt: 3,
        },
      },
      completedRequests: {
        req_completed: {
          tool: 'Write',
          status: 'approved',
          completedAt: 4,
        },
      },
    } as any)).toEqual({
      pendingPermissionRequestCount: 1,
      pendingUserActionRequestCount: 1,
    });
  });
});
