import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import {
  ProjectDeploymentDefaultsOutputV1Schema,
  type ProjectDeploymentDefaultsOutputV1,
} from '@happier-dev/protocol/projects/projectDeploymentDefaultsV1';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { requestHomeDomain } from '@/sync/api/home/homeServerActionTransport';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';

/** The Source's deployment-defaults reference, read through the Account's Home-domain transport. */
export async function readUiProjectDeploymentDefaults(
  account: LazyActionAccountContext,
  sourceId: string,
  context: ActionExecutorContext,
): Promise<ProjectDeploymentDefaultsOutputV1 | ActionExecuteFailure> {
  const response = await requestHomeDomain({
    scope: account.accountLifetime.scope,
    path: `/v1/projects/${encodeURIComponent(sourceId)}/deployment-defaults?serverId=${encodeURIComponent(account.serverIdentityId ?? account.serverId)}`,
    method: 'GET',
    input: undefined,
    schema: ProjectDeploymentDefaultsOutputV1Schema,
    effect: 'read',
    signal: context.signal,
    requestAuthority: account,
  });
  if (response.ok) return response.value;
  const code = homeDomainFailureCode(response.failure);
  return { ok: false, errorCode: code, error: code };
}
