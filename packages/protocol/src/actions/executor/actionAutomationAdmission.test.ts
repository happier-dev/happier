import { describe, expect, it } from 'vitest';

describe('Approval profile subject admission', () => {
  it('matches only the available admission binding, including after access is withdrawn', async () => {
    await import('../actionSpecs.js');
    const { createActionAutomationPortV1 } = await import('./actionAutomationAdmission.js');
    const { automationSubjectKeyV1 } = await import('../../automations/automationSubjectV1.js');
    const subject = { kind: 'approvalProfile' as const, serverId: 'home', profileId: 'profile' };
    const port = createActionAutomationPortV1({ accountId: 'actor', seed: async () => ({ v: 1, rows: [{
      automationId: 'automation', triggerId: 'trigger', triggerRevision: 1, workflowId: 'workflow',
      workflowRevision: 1, ownerAccountId: 'actor', actionIds: ['actions.policy.set'], phase: 'before', mode: 'wait',
      subjectKind: subject.kind, subjectKey: automationSubjectKeyV1(subject),
    }] }), settle: async () => {} });
    const args = { actionId: 'actions.policy.set', input: {}, context: {
      serverIdentityId: 'home', approvalProfileId: 'profile',
    } };
    // A stored id survives revocation and cannot establish current profile availability.
    expect((await port.select(args)).before).toEqual([]);
    const admitted = await port.select({ ...args, context: { ...args.context, approvalProfileId: 'stored-other-profile', approvalProfile: {
      profile: { id: 'profile', name: 'Shared profile' },
      resolution: { status: 'available', requestedId: 'profile' },
    } } });
    expect(admitted.before.map(row => row.automationId)).toEqual(['automation']);
    expect((await port.select({ ...args, context: { ...args.context, approvalProfile: {
      profile: null, resolution: { status: 'missing', requestedId: 'profile' },
    } } })).before).toEqual([]);
    expect(admitted.before.map(row => row.automationId)).toEqual(['automation']);
  });
});
