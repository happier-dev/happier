import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkflowAcceptedAuthorizationV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { buildWorkflowActionContext } from './workflowActionContext';

describe('retained Workflow authority at local Action execution', () => {
  it('keeps the original restricted PAT grant effective after accepted-context serialization', async () => {
    const grant = ApiTokenGrantV1Schema.parse({ ...API_TOKEN_FULL_GRANT_V1,
      actions: { families: [], ids: ['machines.setup.plan'] } });
    const original = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-pat-root', binding: {
      serverIdentityId: 'home', accountId: 'requester', principalId: 'requester', credentialId: 'pat', grant,
      custodianAccountId: 'custodian', machineId: 'machine', installationId: 'installation',
      actionId: 'machines.setup.plan', requestId: 'root-request', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' }, admittedMachineRole: 'manage',
    } });
    const authorization = WorkflowAcceptedAuthorizationV1Schema.parse(JSON.parse(JSON.stringify({
      admittedPermissionCeiling: 'default', principal: {
        kind: 'api', accountId: 'requester', principalId: 'requester', credentialId: 'pat',
      }, externalActionExecutionAuthorization: original,
    })));
    const context = buildWorkflowActionContext({ runId: 'run', authorization });
    const result = await createActionExecutor({}).execute('machines.setup.apply', {
      homeId: 'home', machineId: 'machine', targets: [{ homeId: 'home', machineId: 'machine',
        sources: [{ kind: 'direct', setup: {} }], recipePlans: [], desiredRevision: 0 }],
    }, context);
    expect(result).toMatchObject({ ok: false, errorCode: 'credential_scope_denied' });
    expect(context.externalActionExecutionAuthorization).toEqual(original);
    expect(() => buildWorkflowActionContext({ runId: 'run', authorization: {
      admittedPermissionCeiling: 'default', principal: authorization.principal,
    } })).toThrow('run_access_denied');
  });
});
