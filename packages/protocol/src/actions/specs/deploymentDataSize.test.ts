import { expect, it } from 'vitest';
import { listActionSpecsForSurface } from '../actionSpecs.js';
import { createActionExecutor, type ActionExecutorContext, type ActionExecutorDeps } from '../actionExecutor.js';
import { createDeploymentApprovalScopeResolverV1 } from '../../deployments/deploymentApprovalScopeV1.js';

it('reads only the admitted native service size through the deployment Action executor', async () => {
    const spec = listActionSpecsForSurface('ui').find(entry => String(entry.id) === 'deployments.data.size');
    expect(spec, 'The independent deployment size read must be registered').toBeDefined();
    if (!spec) return;
    expect(spec).toMatchObject({ safety: 'safe', sideEffectClass: 'read', executionPlacement: 'machine' });
    const result = { ok: true, size: { service: 'database', deploymentId: 'deployment',
        size: { status: 'available', bytes: 4096, measurement: 'database_bytes', observedAtMs: 10 },
        growth: { status: 'unavailable', reason: 'previous_sample_required' } } };
    // Home metadata and Machine execution are the system boundaries.
    const transport: NonNullable<ActionExecutorDeps['deploymentAction']> = async () => result;
    const executor = createActionExecutor({ deploymentAction: transport,
        resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(transport, async () => ({ ok: true,
            environment: { id: 'production', projectSourceId: 'project', purpose: 'standard' } })),
    });
    const context: ActionExecutorContext = { surface: 'ui', authority: 'present_user', serverId: 'home',
        runtimeAccountId: 'owner', actionRequestId: 'size' };
    const input = { serverId: 'home', environmentId: 'production', expectedRevision: 1,
        machineId: 'runtime', installationId: 'installed', targetLinkId: 'target', deploymentId: 'deployment', service: 'database' };
    expect(await executor.execute(spec.id, input, context)).toEqual({ ok: true, result });
    expect(await executor.execute(spec.id, { ...input, sql: 'DELETE FROM data' }, context))
        .toMatchObject({ ok: false, errorCode: 'invalid_parameters' });
});
