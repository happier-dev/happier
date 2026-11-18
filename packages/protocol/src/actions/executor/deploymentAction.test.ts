import { createDeploymentEnvironmentHeaderV1, createDeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { describe, expect, it } from 'vitest';
import { createActionExecutor } from '../actionExecutor.js';
import { createDeploymentApprovalScopeResolverV1 } from '../../deployments/deploymentApprovalScopeV1.js';
import type { ActionExecutorDeps } from './types.js';

describe('deployment receipt list Action', () => {
  it('projects header-based recovery without opening retained content', async () => {
    const failed = createDeploymentReceiptHeaderV1({ id: 'failed', state: 'failed' });
    const succeeded = createDeploymentReceiptHeaderV1({ id: 'succeeded' });
    const input = { serverId: 'home', environmentId: failed.environmentId };
    const environment = createDeploymentEnvironmentHeaderV1({ id: input.environmentId, serverId: input.serverId });
    // The Home metadata transport is the boundary. Both callers use the real Action executor.
    const deploymentAction: NonNullable<ActionExecutorDeps['deploymentAction']> = async actionId =>
      actionId === 'deployments.environments.get' ? { ok: true, environment, targetLinks: [] }
        : { ok: true, items: [failed, succeeded], nextCursor: 'next-page' };
    const executor = createActionExecutor({
      deploymentAction,
      resolveEnvironmentApprovalScope: createDeploymentApprovalScopeResolverV1(deploymentAction),
    });
    const ui = await executor.execute('deployments.receipts.list', input, {
      surface: 'ui', authority: 'present_user', serverId: input.serverId,
    });
    const cli = await executor.execute('deployments.receipts.list', input, {
      surface: 'cli', authority: 'present_user', serverId: input.serverId,
    });
    expect(ui).toEqual({ ok: true, result: { ok: true, items: [
      { ...failed, requiredFact: 'deploymentActionResult', remedy: expect.any(String) },
      succeeded,
    ], nextCursor: 'next-page' } });
    expect(cli).toEqual(ui);
  });
});
