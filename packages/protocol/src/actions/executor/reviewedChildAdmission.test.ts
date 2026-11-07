import { describe, expect, it } from 'vitest';
import * as issuer from './deploymentRoleChild.js';
import type { ActionExecutorContext } from './types.js';
import { ExternalActionExecutionAuthorizationV1Schema } from '../externalActionApi.js';
import { computeActionInputApprovalDigestV1 } from '../decisionAuthority.js';
import { SESSION_AGENT_READINESS_CHILDREN_V1 } from '../../machines/managed/actionIdsV1.js';
import { API_TOKEN_FULL_GRANT_V1 } from '../../auth/apiTokenGrant.js';

describe('ordinary reviewed child admission transport', () => {
  it('retains the exact accepted operand without admitting a serialized or different child', async () => {
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'root', binding: {
      serverIdentityId: 'home', accountId: 'member', principalId: 'member', credentialId: 'credential',
      grant: API_TOKEN_FULL_GRANT_V1, custodianAccountId: 'owner',
      machineId: 'machine', installationId: 'installation', actionId: 'session.spawn_new',
      requestId: 'request', requestEnvelopeDigest: 'A'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' }, admittedMachineRole: 'use',
    } });
    const context: ActionExecutorContext = { runtimeAccountId: 'member',
      externalActionExecutionAuthorization: authorization, externalActionTarget: authorization.binding.target };
    const child = SESSION_AGENT_READINESS_CHILDREN_V1.acquire;
    const input = { machineId: 'machine', agentId: 'codex', intent: 'install' };
    await issuer.invokeHostReviewedChildV1({ context,
      parent: { actionId: 'session.spawn_new', input: { machineId: 'machine' } },
      child: { ...child, input }, execute: async (_input, childContext) => {
        expect(issuer.readHostAdmittedReviewedChildV1(childContext)).toBeNull();
        const retain: unknown = Reflect.get(issuer, 'retainHostReviewedChildAdmissionV1');
        if (typeof retain !== 'function') throw new Error('ordinary accepted child admission is not retained');
        const admitted: ActionExecutorContext | undefined = retain(childContext, child.action, input);
        expect(issuer.readHostAdmittedReviewedChildV1(admitted)).toEqual({ actionId: child.action,
          role: child.role, input, inputDigest: computeActionInputApprovalDigestV1(child.action, input) });
        expect(retain(childContext, child.action, { ...input, agentId: 'claude' })).toBeUndefined();
        expect(retain(context, child.action, input)).toBeUndefined();
        expect(retain({ ...childContext, externalActionExecutionAuthorization: {
          ...authorization, binding: { ...authorization.binding, actionId: 'machines.agents.list' },
        } }, child.action, input)).toBeUndefined();
        expect(issuer.readHostAdmittedReviewedChildV1(childContext)).toBeNull();
        return { ok: true, result: null };
      } });
  });
});
