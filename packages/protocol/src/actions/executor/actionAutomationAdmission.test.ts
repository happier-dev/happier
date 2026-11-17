import { describe, expect, it } from 'vitest';
import '../actionSpecs.js';
import { createActionAutomationPortV1 } from './actionAutomationAdmission.js';
import { automationSubjectKeyV1 } from '../../automations/automationSubjectV1.js';

describe('Approval profile subject admission', () => {
  it('matches only the available admission binding, including after access is withdrawn', async () => {
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
