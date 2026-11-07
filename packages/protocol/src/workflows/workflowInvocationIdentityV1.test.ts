import { describe, expect, it } from 'vitest';
import { deriveMachineSetupCombinedRunIdV1, deriveWorkflowReplacementId } from './workflowInvocationIdentityV1.js';

describe('Machine Setup combined Run identity', () => {
  const root = { homeId: 'home', accountId: 'requester', requestId: 'signed-root' };
  const reviewedChild = { role: 'reviewed-setup', inputDigest: 'reviewed-input-digest' };

  it('retains the incumbent direct Setup Run identity', () => {
    expect(deriveMachineSetupCombinedRunIdV1(root)).toBe(
      deriveWorkflowReplacementId(['machines.setup.apply', root.homeId, root.accountId, root.requestId]));
  });

  it('binds a reviewed child Run to its original root and exact reviewed operand', () => {
    const child = { ...root, reviewedChild };
    const runId = deriveMachineSetupCombinedRunIdV1(child);
    expect(deriveMachineSetupCombinedRunIdV1({ ...root, reviewedChild: { ...reviewedChild } })).toBe(runId);
    for (const sibling of [
      root,
      { ...child, requestId: 'another-signed-root' },
      { ...child, accountId: 'another-requester' },
      { ...child, homeId: 'another-home' },
      { ...child, reviewedChild: { ...reviewedChild, role: 'another-setup-role' } },
      { ...child, reviewedChild: { ...reviewedChild, inputDigest: 'another-reviewed-input-digest' } },
    ]) expect(deriveMachineSetupCombinedRunIdV1(sibling)).not.toBe(runId);
  });
});
