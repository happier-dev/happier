import { describe, expect, it } from 'vitest';
import { WorkflowActionIdV1Schema } from '../../actions/actionIds.js';
import { WorkflowActionInputSchemasV1 } from '../actionsV1.js';
import { WorkflowActionFailureV1Schema } from '../workflowProgressV1.js';
import { SessionTriggerListResultV1Schema } from './workflowTriggerActionsV1.js';

describe('workflow trigger Action boundary', () => {
  it('distinguishes unavailable PR links from a successfully empty projection', () => {
    const unavailable = { sessionId: 'session-one', sets: [], pullRequestLinks: { status: 'unavailable', code: 'target_unavailable' } };
    expect(SessionTriggerListResultV1Schema.safeParse(unavailable).success).toBe(true);
    expect(SessionTriggerListResultV1Schema.parse({ sessionId: 'session-one', sets: [], pullRequestLinks: [] }).pullRequestLinks).toEqual([]);
    expect(SessionTriggerListResultV1Schema.safeParse({ ...unavailable, pullRequestLinks: { ...unavailable.pullRequestLinks, links: [] } }).success).toBe(false);
  });
  it('qualifies session PR-link reads instead of accepting an unaddressed list', () => {
    const pullRequestLinks = [{ provider: 'github', repository: 'happier-dev/happier', number: 42 }];
    expect(SessionTriggerListResultV1Schema.safeParse({ sets: [], pullRequestLinks }).success).toBe(false);
    expect(SessionTriggerListResultV1Schema.parse({ sessionId: 'session-one', sets: [], pullRequestLinks }))
      .toEqual({ sessionId: 'session-one', sets: [], pullRequestLinks });
  });
  it('preserves closed conversion and currentness refusal details', () => {
    expect(WorkflowActionFailureV1Schema.safeParse({ ok: false, errorCode: 'legacy_conversion_unsupported',
      error: 'legacy_conversion_unsupported', details: { reason: 'settings_unrepresentable' } }).success).toBe(true);
    expect(WorkflowActionFailureV1Schema.safeParse({ ok: false, errorCode: 'currentness_conflict',
      error: 'currentness_conflict', details: { revision: 2 } }).success).toBe(true);
    expect(WorkflowActionFailureV1Schema.safeParse({ ok: false, errorCode: 'source_unavailable', error: 'source_unavailable' }).success).toBe(true);
  });
  it('accepts the account-inline list through the canonical workflow Action family', () => {
    const id = WorkflowActionIdV1Schema.parse('workflow.trigger.list');
    expect(WorkflowActionInputSchemasV1[id].parse({ scope: 'account_inline' })).toEqual({ scope: 'account_inline' });
    expect(WorkflowActionInputSchemasV1[id].safeParse({ scope: 'account_inline', workflow: 'builtin:keep-going' }).success).toBe(false);
  });
});
