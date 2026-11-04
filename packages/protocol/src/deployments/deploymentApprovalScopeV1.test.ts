import { describe, expect, it } from 'vitest';
import { createDeploymentApprovalScopeResolverV1 } from './deploymentApprovalScopeV1.js';

describe('deployment approval scope failure', () => {
  it('retains the typed Environment validation refusal before a Link replay', async () => {
    const refusal = { ok: false as const, error: 'deployment_invalid' as const,
      diagnostic: { step: 'target_link.environment_read' as const, field: 'serverId', rule: 'invalid_type' as const } };
    // The Home metadata response is the boundary; the scope resolver stays real.
    const resolve = createDeploymentApprovalScopeResolverV1(async () => refusal);
    expect(await resolve({ actionId: 'deployments.targets.link',
      input: { serverId: 'home', environmentId: 'staging' }, context: {}, phase: 'replay' }))
      .toEqual({ ok: false, errorCode: 'deployment_invalid', error: 'deployment_invalid', details: refusal });
  });

});
