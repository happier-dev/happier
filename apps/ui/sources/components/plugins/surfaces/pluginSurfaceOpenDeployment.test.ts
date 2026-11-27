import { describe, expect, it, vi } from 'vitest';
import { createDeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { createPluginSurfaceOpenDeploymentHandler } from './pluginSurfaceOpenDeployment';

const lifetime = {
  scope: { serverId: 'home', accountId: 'account' },
  isCurrent: () => true,
  onRetire: () => ({ dispose() {} }),
};
const readResult = DeploymentEnvironmentGetResultV1Schema.parse({
  ok: true,
  environment: createDeploymentEnvironmentHeaderV1({
    id: 'env-preview-142',
    serverId: lifetime.scope.serverId,
    projectSourceId: 'source-checkout',
    owner: { kind: 'account', accountId: lifetime.scope.accountId },
  }),
  targetLinks: [],
});

/** The Home's Action transport is the boundary; the front door, parsing and route owner stay real. */
function harness(
  read: (input: unknown) => unknown = () => ({ ok: true, result: readResult }),
) {
  const reads: unknown[] = [];
  const execute = createFrontDoorActionExecute({
    execute: (async (actionId: string, input: unknown) => {
      if (actionId !== 'deployments.environments.get')
        throw new Error(`Unexpected Action ${actionId}`);
      reads.push(input);
      return read(input);
    }) as never,
  });
  const navigate = vi.fn();
  const open = (payload: unknown, isCurrent = () => true) =>
    createPluginSurfaceOpenDeploymentHandler({
      accountLifetime: lifetime,
      isCurrent,
      navigate,
      execute,
    })({ method: 'openDeployment', payload } as never);
  return { open, navigate, reads };
}

describe('openDeployment host navigation', () => {
  it('opens the Environment, a receipt, a tab or a Settings section on the Deployments page from one read', async () => {
    const { open, navigate, reads } = harness();
    expect(
      await open({
        environmentId: 'env-preview-142',
        receiptId: 'deploy-7',
        tab: 'settings',
        section: 'previews',
      }),
    ).toBeNull();
    expect(reads).toEqual([
      { serverId: 'home', environmentId: 'env-preview-142' },
    ]);
    expect(navigate).toHaveBeenCalledWith({
      pathname: '/deployments/[projectSourceId]',
      params: {
        projectSourceId: 'source-checkout',
        serverId: 'home',
        deploymentEnvironment: 'env-preview-142',
        deployment: 'deploy-7',
        deploymentTab: 'settings',
        deploymentSection: 'previews',
      },
    });
  });

  it('opens Overview for an unknown tab and History by its id', async () => {
    const { open, navigate } = harness();
    await open({ environmentId: 'env-preview-142', tab: 'not-a-tab' });
    await open({ environmentId: 'env-preview-142', tab: 'history' });
    expect(
      navigate.mock.calls.map(([route]) => route.params.deploymentTab),
    ).toEqual([undefined, 'history']);
  });

  it('navigates nowhere for another Home, an Environment the viewer cannot read, or a retired mount', async () => {
    const denied = harness(() => ({
      ok: false,
      errorCode: 'deployment_not_found',
      error: 'deployment_not_found',
    }));
    expect(
      await denied.open({ environmentId: 'env-preview-142' }),
    ).toMatchObject({ code: 'unavailable' });
    const elsewhere = harness();
    expect(
      await elsewhere.open({
        environmentId: 'env-preview-142',
        serverId: 'other-home',
      }),
    ).toMatchObject({ code: 'unavailable' });
    expect(elsewhere.reads).toHaveLength(0);
    const retired = harness();
    expect(
      await retired.open({ environmentId: 'env-preview-142' }, () => false),
    ).toMatchObject({ code: 'stale_surface' });
    const invalid = harness();
    expect(await invalid.open({ environmentId: '' })).toMatchObject({
      code: 'invalid_payload',
    });
    expect(
      [denied, elsewhere, retired, invalid].every(
        ({ navigate }) => navigate.mock.calls.length === 0,
      ),
    ).toBe(true);
  });
});
