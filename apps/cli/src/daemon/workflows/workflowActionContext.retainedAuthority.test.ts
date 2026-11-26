import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions';
import { API_TOKEN_FULL_GRANT_V1, ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { WorkflowAcceptedAuthorizationV1Schema } from '@happier-dev/protocol/workflows/workflowDefinitionV1';
import { buildWorkflowActionContext } from './workflowActionContext';

describe('retained Workflow authority at local Action execution', () => {
  it('carries the admitted person’s Session policy without changing Workflow transport authority', () => {
    const authorization = WorkflowAcceptedAuthorizationV1Schema.parse({ admittedPermissionCeiling: 'default',
      principal: { kind: 'host' } });
    const policy = { surface: 'cli', authority: 'present_user' } as const;
    const authenticatedStarterV1 = { requestRef: 'request', requester: { serverId: 'home', accountId: 'starter' } };
    const context = buildWorkflowActionContext({ runId: 'run', authorization,
      origin: { kind: 'direct', actionPolicy: policy, authenticatedStarterV1 } });
    expect(context).toMatchObject({ surface: 'agent', authority: 'account_automation',
      actionCaller: { authenticatedStarterV1, authenticatedStarterPolicySurface: 'cli' } });
    const unstamped = buildWorkflowActionContext({ runId: 'run', authorization,
      origin: { kind: 'direct', actionPolicy: policy } });
    expect(unstamped.actionCaller).not.toHaveProperty('authenticatedStarterPolicySurface');
  });

  it.each([
    { source: { kind: 'saved' as const, definitionId: 'saved-hunt', revision: { headerVersion: 2, bodyVersion: 2 }, savedBy: null }, workflowId: 'saved-hunt' },
    { source: { kind: 'automation' as const, automationId: 'schedule', definitionId: 'saved-hunt', revision: { headerVersion: 2, bodyVersion: 2 }, savedBy: null }, workflowId: 'saved-hunt' },
    { source: { kind: 'inline' as const }, workflowId: undefined },
    { source: { kind: 'inline' as const, sourceArtifactId: 'grant-lineage-only' }, workflowId: undefined },
    { source: { kind: 'automation' as const, automationId: 'inline-schedule' }, workflowId: undefined },
    { source: { kind: 'catalog' as const, ref: 'builtin:repository-review', version: 1 }, workflowId: undefined },
  ])('retains the accepted saved source without inventing identity for $source.kind', ({ source, workflowId }) => {
    const execution = { runId: 'run-attempt-2', source,
      authorization: WorkflowAcceptedAuthorizationV1Schema.parse({ admittedPermissionCeiling: 'read-only', principal: { kind: 'host' } }) };
    expect(buildWorkflowActionContext(execution).actionCaller).toMatchObject({ kind: 'workflowRun', runId: 'run-attempt-2',
      ...(workflowId ? { workflowId } : {}) });
    if (!workflowId) expect(buildWorkflowActionContext(execution).actionCaller).not.toHaveProperty('workflowId');
  });
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
