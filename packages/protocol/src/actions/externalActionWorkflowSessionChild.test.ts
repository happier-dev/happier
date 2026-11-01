import { expect, it } from 'vitest';
import { ExternalActionWorkflowOriginV1Schema } from './externalActionApi.js';

it('keeps the signed Session leaf caller and accepted requester facts closed', () => {
  const origin = { runId: 'run', requestId: 'child', sessionLeaf: {
    invocationId: 'invocation', caller: { kind: 'session', sessionId: 'leaf', starterDepth: 1, turnDepth: 2 },
    authorization: { principal: { kind: 'host' }, admittedPermissionCeiling: 'default' }, workspaceWrites: 'deny',
    actionRequestAttributionV1: { requestRef: 'request', requester: { serverId: 'home', accountId: 'requester' },
      persona: { serverId: 'home', sessionId: 'original' }, origin: null },
  } };
  expect(ExternalActionWorkflowOriginV1Schema.parse(origin)).toEqual(origin);
  for (const sessionLeaf of [{ ...origin.sessionLeaf, caller: { kind: 'host' } },
    { ...origin.sessionLeaf, invocationId: '' }, { ...origin.sessionLeaf, authority: 'present_user' }]) {
    expect(ExternalActionWorkflowOriginV1Schema.safeParse({ ...origin, sessionLeaf }).success).toBe(false);
  }
});
