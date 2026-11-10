import { describe, expect, it } from 'vitest';
import { listActionSpecsForSurface } from '../actionSpecs.js';
import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from '../actionExecutor.js';
import { createDeploymentApprovalScopeResolverV1 } from '../../deployments/deploymentApprovalScopeV1.js';
import { projectDeploymentReadAdmissionV1 } from '../../deployments/deploymentReadAdmissionV1.js';
import { DeploymentDataQueryInputV1Schema, DeploymentDataQueryStatementV1Schema, DeploymentDataQuerySuccessV1Schema, type DeploymentDataQuerySuccessV1 } from '../../deployments/deploymentReadsV1.js';

describe('database read-only query Action', () => {
  const input = { serverId: 'home', environmentId: 'production', expectedRevision: 1,
    machineId: 'runtime', installationId: 'installed', targetLinkId: 'target', deploymentId: 'deployment',
    service: 'database', sql: "select :'value'", params: { value: 'private data' } };
  it('admits only deployment references outside the protected SQL input', () => {
    expect(projectDeploymentReadAdmissionV1('deployments.data.query', input)).toEqual({
      actionId: 'deployments.data.query', environmentId: 'production', expectedRevision: 1,
      machineId: 'runtime', installationId: 'installed', targetLinkId: 'target', deploymentId: 'deployment',
    });
    expect(DeploymentDataQueryInputV1Schema.safeParse({ ...input, password: 'caller credential' }).success).toBe(false);
    expect(DeploymentDataQueryInputV1Schema.safeParse({ ...input, params: { value: null } }).success).toBe(false);
  });
  it.each(['ON_ERROR_STOP', 'happier_query_sql'])('rejects native client-control parameter %s in the real Action contract', name => {
    const result = DeploymentDataQueryInputV1Schema.safeParse({ ...input, params: { [name]: 'off' } });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues.some(issue => JSON.stringify(issue).includes('invalid_query_parameter'))).toBe(true);
  });
  it('keeps native near-case names and managed positional parameter keys valid', () => {
    expect(DeploymentDataQueryInputV1Schema.safeParse({ ...input,
      params: { on_error_stop: 'ordinary value', happier: 'ordinary value', a0_b: 'ordinary value' } }).success).toBe(true);
    expect(DeploymentDataQueryStatementV1Schema.safeParse({ sql: 'SELECT $1', params: { '1': 'ordinary value' } }).success).toBe(true);
  });
  it('rejects ragged results instead of silently losing column identity', () => {
    expect(DeploymentDataQuerySuccessV1Schema.safeParse({ ok: true, columns: [{ name: 'a' }],
      rows: [[1, 2]], complete: true }).success).toBe(false);
    expect(DeploymentDataQuerySuccessV1Schema.parse({ ok: true, columns: [{ name: 'a' }, { name: 'a' }],
      rows: [[null, '']], complete: false, diagnostic: { code: 'output_truncated' } })).toMatchObject({ rows: [[null, '']], complete: false });
  });
  it('executes an agent query through the shared policy owner without a default approval', async () => {
    const spec = listActionSpecsForSurface('agent').find(entry => String(entry.id) === 'deployments.data.query');
    expect(spec, 'The database query must be a real Action').toBeDefined();
    if (!spec) return;
    expect(spec).toMatchObject({ safety: 'safe', sideEffectClass: 'read', executionPlacement: 'machine' });
    const result: DeploymentDataQuerySuccessV1 = { ok: true, columns: [{ name: 'value' }], rows: [[1]], complete: true };
    // Deployment transport and its Home metadata response are system boundaries;
    // the real approval-scope and policy owners remain in the path.
    const transport: NonNullable<ActionExecutorDeps['deploymentAction']> = async () => result;
    const executor = createActionExecutor({ deploymentAction: transport,
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(transport, async () => ({ ok: true,
        environment: { id: 'production', projectSourceId: 'project', purpose: 'standard' } })),
    });
    const context: ActionExecutorContext = { surface: 'agent', authority: 'account_automation',
      actionCaller: { kind: 'host' }, serverId: 'home', runtimeAccountId: 'owner', actionRequestId: 'query' };
    const query = await executor.execute(spec.id, { serverId: 'home', environmentId: 'production', expectedRevision: 1,
      machineId: 'runtime', installationId: 'installed', targetLinkId: 'target', deploymentId: 'deployment',
      service: 'database', sql: 'select 1 as value', params: {} }, context);
    expect(query).toEqual({ ok: true, result });
  });
});
