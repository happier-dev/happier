import { describe, expect, it } from 'vitest';

import { resolveAgentStateRequestCoverageOptions } from '@happier-dev/agents';
import { deriveActivitySummaryFromAgentState } from './deriveActivitySummaryFromAgentState';

const localPermissionBridgeCoverageOptions = resolveAgentStateRequestCoverageOptions({ kind: 'localPermissionBridge' });
const LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE = localPermissionBridgeCoverageOptions.equivalentSources?.[0] ?? '';
const LOCAL_PERMISSION_BRIDGE_STOPPED_REASON = localPermissionBridgeCoverageOptions.equivalentCompletedReasons?.[0] ?? '';

describe('deriveActivitySummaryFromAgentState', () => {
  it('counts unresolved permission and user-action requests separately', () => {
    expect(deriveActivitySummaryFromAgentState({
      requests: {
        req_permission: {
          tool: 'Write',
          arguments: { path: '/tmp/a.ts' },
          createdAt: 100,
        },
        req_action: {
          tool: 'AskUserQuestion',
          kind: 'user_action',
          arguments: { question: 'Ship it?' },
          createdAt: 250,
        },
        req_completed: {
          tool: 'Write',
          arguments: { path: '/tmp/b.ts' },
          createdAt: 500,
        },
      },
      completedRequests: {
        req_completed: {
          tool: 'Write',
          arguments: { path: '/tmp/b.ts' },
          status: 'approved',
          completedAt: 600,
        },
      },
    } as any)).toEqual({
      pendingPermissionRequestCount: 1,
      pendingUserActionRequestCount: 1,
      pendingRequestNewestCreatedAt: 250,
    });
  });

  it('ignores a generated local-bridge request covered by a recent canonical cancellation', () => {
    const question = { questions: [{ question: 'How should I proceed?', options: [{ label: 'Continue' }] }] };

    expect(deriveActivitySummaryFromAgentState({
      requests: {
        perm_generated: {
          tool: 'AskUserQuestion',
          kind: 'user_action',
          arguments: question,
          createdAt: 10_500,
          source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
        },
      },
      completedRequests: {
        toolu_canonical: {
          tool: 'AskUserQuestion',
          kind: 'user_action',
          arguments: question,
          createdAt: 1_000,
          completedAt: 10_000,
          status: 'canceled',
          reason: LOCAL_PERMISSION_BRIDGE_STOPPED_REASON,
          source: LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE,
        },
      },
    } as any)).toEqual({
      pendingPermissionRequestCount: 0,
      pendingUserActionRequestCount: 0,
      pendingRequestNewestCreatedAt: null,
    });
  });
});
