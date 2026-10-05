import { describe, expect, it } from 'vitest';

import { resolveAgentStateRequestCoverageOptions } from '@happier-dev/agents';
import { deriveActivitySummaryFromAgentState } from './deriveActivitySummaryFromAgentState';

const localPermissionBridgeCoverageOptions = resolveAgentStateRequestCoverageOptions({ kind: 'localPermissionBridge' });
const LOCAL_PERMISSION_BRIDGE_REQUEST_SOURCE = localPermissionBridgeCoverageOptions.equivalentSources?.[0] ?? '';
const LOCAL_PERMISSION_BRIDGE_STOPPED_REASON = localPermissionBridgeCoverageOptions.equivalentCompletedReasons?.[0] ?? '';

describe('deriveActivitySummaryFromAgentState', () => {
  it('counts Action confirmations as approval attention without changing their user-action shape', () => {
    const confirmation = { tool: 'Happier Action confirmation', kind: 'user_action' as const,
      source: 'happier_action', arguments: {}, createdAt: 100 };
    const question = { tool: 'AskUserQuestion', kind: 'user_action' as const, arguments: {}, createdAt: 200 };
    expect(deriveActivitySummaryFromAgentState({ requests: { confirmation, question } })).toMatchObject({
      pendingPermissionRequestCount: 1, pendingUserActionRequestCount: 1, pendingRequestNewestCreatedAt: 200,
    });
  });
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
      newUserActionRequiredOccurrences: [],
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
      newUserActionRequiredOccurrences: [],
    });
  });

  it('projects only newly added main-turn request identities without private request content', () => {
    const previous = {
      requests: {
        req_existing: {
          tool: 'Write',
          arguments: { secret: 'old' },
          createdAt: 100,
          turnId: 'turn_1',
        },
      },
      completedRequests: {
        req_reused: {
          tool: 'Write',
          arguments: { secret: 'settled' },
          createdAt: 50,
          completedAt: 75,
          status: 'approved',
        },
      },
    };
    const updated = {
      requests: {
        ...previous.requests,
        req_permission: {
          tool: 'Write',
          arguments: { secret: 'do-not-project' },
          createdAt: 200,
          turnId: 'turn_2',
        },
        req_action: {
          tool: 'AskUserQuestion',
          kind: 'user_action',
          arguments: { question: 'do-not-project' },
          createdAt: 250,
          turnId: 'turn_2',
        },
        req_subagent: {
          tool: 'Write',
          arguments: {},
          createdAt: 300,
          turnId: 'turn_2',
          subagentRef: { id: 'subagent' },
        },
        req_sidechain: {
          tool: 'Write',
          arguments: {},
          createdAt: 350,
          turnId: 'turn_2',
          sidechainId: 'sidechain',
        },
        req_without_turn: {
          tool: 'Write',
          arguments: {},
          createdAt: 400,
        },
        req_reused: {
          tool: 'Write',
          arguments: {},
          createdAt: 450,
          turnId: 'turn_2',
        },
      },
      completedRequests: previous.completedRequests,
    };

    expect(deriveActivitySummaryFromAgentState(updated as any, previous as any))
      .toMatchObject({
        newUserActionRequiredOccurrences: [
          {
            requestId: 'req_permission',
            sourceTurnId: 'turn_2',
            requestKind: 'permission',
            occurredAt: 200,
          },
          {
            requestId: 'req_action',
            sourceTurnId: 'turn_2',
            requestKind: 'user_action',
            occurredAt: 250,
          },
        ],
      });
  });
});
