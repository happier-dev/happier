import { describe, expect, it } from 'vitest';
import { getActionSpec } from './actionSpecs.js';

describe('workflow review Action authority', () => {
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
