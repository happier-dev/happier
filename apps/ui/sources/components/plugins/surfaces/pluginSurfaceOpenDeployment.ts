import { resolveDeploymentEnvironmentDestinationV1 } from '@happier-dev/deployments';
import { DeploymentEnvironmentGetResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { PluginUiOpenDeploymentRequestV1Schema } from '@happier-dev/protocol/plugins/ui/client';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { deploymentEnvironmentRoute } from '@/components/projects/deployments/deploymentNavigation';
import {
  createPluginSurfaceHostApiError,
  type PluginSurfaceHostApiMethodHandler,
} from './createPluginSurfaceHostApi';

type DeploymentRoute = ReturnType<typeof deploymentEnvironmentRoute>;

/**
 * `openDeployment`: navigation only. The Environment's Project comes from the viewer's own
 * `deployments.environments.get` read (the same Action every Deployments page uses), so a plugin names
 * only the Environment and gains no access by opening it: the page then reads it with the viewer's access.
 */
export function createPluginSurfaceOpenDeploymentHandler(
  input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    isCurrent(): boolean;
    navigate(route: DeploymentRoute): void;
    execute?: ReturnType<typeof createFrontDoorActionExecute>;
  }>,
): PluginSurfaceHostApiMethodHandler {
  const { accountLifetime } = input;
  const isCurrent = () => input.isCurrent() && accountLifetime.isCurrent();
  return async (request, options) => {
    const payload = PluginUiOpenDeploymentRequestV1Schema.safeParse(
      request.payload,
    );
    if (!payload.success)
      return createPluginSurfaceHostApiError('invalid_payload');
    if (!isCurrent()) return createPluginSurfaceHostApiError('stale_surface');
    const { serverId } = accountLifetime.scope;
    // Another Home is another Account's page; this mount navigates only within its own.
    if (
      payload.data.serverId !== undefined &&
      !areServerProfileIdentifiersEquivalent(payload.data.serverId, serverId)
    ) {
      return createPluginSurfaceHostApiError('unavailable', [
        'deployment_home_not_active',
      ]);
    }
    if (options?.signal?.aborted)
      return createPluginSurfaceHostApiError('aborted');
    const execute = input.execute ?? createFrontDoorActionExecute();
    const read = await execute(
      'deployments.environments.get',
      { serverId, environmentId: payload.data.environmentId },
      {
        surface: 'ui',
        serverId,
        expectedAccountId: accountLifetime.scope.accountId,
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    if (!isCurrent()) return createPluginSurfaceHostApiError('stale_surface');
    if (options?.signal?.aborted)
      return createPluginSurfaceHostApiError('aborted');
    const detail = read.ok
      ? DeploymentEnvironmentGetResultV1Schema.safeParse(read.result).data
      : undefined;
    if (!detail?.ok || detail.environment.id !== payload.data.environmentId) {
      return createPluginSurfaceHostApiError('unavailable', [
        'deployment_environment_unavailable',
      ]);
    }
    const destination = resolveDeploymentEnvironmentDestinationV1({
      tab: payload.data.tab,
      section: payload.data.section,
    });
    input.navigate(
      deploymentEnvironmentRoute({
        serverId,
        projectSourceId: detail.environment.projectSourceId,
        environmentId: detail.environment.id,
        ...(payload.data.receiptId
          ? { deploymentId: payload.data.receiptId }
          : {}),
        ...(destination.tab === 'overview' ? {} : { tab: destination.tab }),
        ...(destination.section === null
          ? {}
          : { section: destination.section }),
      }),
    );
    return null;
  };
}
