import { describe, expect, it } from 'vitest';

import { buildActivityNotificationContent } from './buildActivityNotificationContent';
import { resolveActivityNotificationPolicyEvent } from './dispatchActivityNotification';
import { buildLiveActivityRemoteUpdateRequest } from './liveActivity/buildLiveActivityRemoteUpdateRequest';

describe('workflow Run update notification', () => {
  it('carries only exact safe Run navigation metadata', () => {
    const event = {
      topic: 'workflow_run_update' as const,
      runId: 'run-1',
      updateKind: 'interrupted' as const,
      reason: { code: 'approval_required' },
    };
    expect(buildActivityNotificationContent(event, { readyIncludeMessageText: false })).toEqual({
      title: 'A workflow was interrupted',
      body: 'Open it to choose how to continue.',
      data: {
        topic: 'workflow_run_update',
        runId: 'run-1',
        updateKind: 'interrupted',
        reason: { code: 'approval_required' },
      },
    });
  });

  it('rejects malformed workflow update data before push or webhook projection', () => {
    expect(() => buildActivityNotificationContent({
      topic: 'workflow_run_update',
      runId: '',
      updateKind: 'interrupted',
    }, { readyIncludeMessageText: false })).toThrow();
    expect(() => buildActivityNotificationContent({
      topic: 'workflow_run_update',
      runId: 'run-1',
      updateKind: 'invented',
    } as never, { readyIncludeMessageText: false })).toThrow();
  });

  it.each([
    ['completed', 'task_completed'],
    ['completed_with_failures', 'task_completed'],
    ['failed', 'task_failed'],
    ['outcome_uncertain', 'task_failed'],
    ['paused', 'user_action_request'],
    ['interrupted', 'user_action_request'],
  ] as const)('maps %s into existing attention policy event %s', (updateKind, expected) => {
    expect(resolveActivityNotificationPolicyEvent({ topic: 'workflow_run_update', runId: 'run-1', updateKind }))
      .toBe(expected);
  });

  it('does not widen Session-shaped Live Activity', () => {
    expect(buildLiveActivityRemoteUpdateRequest({
      event: { topic: 'workflow_run_update', runId: 'run-1', updateKind: 'completed' },
      decision: { delivery: 'deliver' } as never,
      serverId: 'server-1',
      nowMs: 1,
    })).toBeNull();
  });
});
