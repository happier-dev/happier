import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';
import { resolveActionApprovalRouting } from './actionApprovalPolicy.js';
import { normalizeActionsSettingsV1 } from './actionSettings.js';

describe('workflow review Action authority', () => {
  it.each(['agent', 'mcp'] as const)('asks by default on %s and honors an explicit waiver', surface => {
    const actionId = 'workflow.run.invocations.complete_review';
    const args = { actionId, spec: getActionSpec(actionId), context: {
      surface, authority: 'account_automation', actionCaller: { kind: 'host' },
    } } as const;
    expect(resolveActionApprovalRouting({ ...args, settings: normalizeActionsSettingsV1({ v: 1 }) }).required).toBe(true);
    expect(resolveActionApprovalRouting({ ...args, settings: normalizeActionsSettingsV1({ v: 1,
      approvalWaivedSurfaces: { [actionId]: [surface] },
    }) }).required).toBe(false);
    expect(resolveActionApprovalRouting({ ...args, context: { surface: 'ui', authority: 'present_user',
      actionCaller: { kind: 'host' } }, settings: normalizeActionsSettingsV1({ v: 1 }) }).required).toBe(false);
  });
  it('allows draft publication and review completion under ordinary configurable Action approval', () => {
    const publication = getActionSpec('workflow.run.invocations.publish_draft');
    const completion = getActionSpec('workflow.run.invocations.complete_review');
    expect(publication).toMatchObject({ executionPlacement: 'account', requiredAuthority: 'account_automation', sideEffectClass: 'write' });
    expect(completion).toMatchObject({ executionPlacement: 'account', requiredAuthority: 'account_automation', sideEffectClass: 'write' });
    const target = { runId: 'run-1', invocation: { recordId: 'inv-1' }, expectedContentRevision: '0' };
    expect(completion.inputSchema.safeParse({ ...target, mode: 'use_result' }).success).toBe(true);
    expect(completion.inputSchema.safeParse({ ...target, mode: 'generate' }).success).toBe(true);
  });
});
