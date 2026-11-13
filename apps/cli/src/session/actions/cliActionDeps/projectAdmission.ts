import type { CliActionDepsParams } from './types';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { readProjectAccountRows, ProjectAccountRowsInput, ProjectAccountRowsSelection } from '@/workspaces/projectAccountRows';
import type { isServerProfileHomeIdentity, resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { areServerProfileIdentifiersEquivalent } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
export type CliProjectAdmissionFailure = Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>;
export type CliProjectAdmission = Readonly<{
  resolveProjectHomeIdentity: () => Promise<string>;
  projectHomeAdmission: (serverId?: string, context?: ActionExecutorContext) => Promise<CliProjectAdmissionFailure | null>;
  projectAccountAdmission: (serverId?: string, context?: ActionExecutorContext) => Promise<CliProjectAdmissionFailure | null>;
  withProjectHome: <T>(operation: () => Promise<T>) => Promise<T>;
  projectRowsAuthority: (context?: ActionExecutorContext, effectActionId?: string, signal?: AbortSignal) => ProjectAccountRowsInput;
  assertProjectRequesterCurrent: (context?: ActionExecutorContext) => Promise<void>;
  readProjectRows: (selection: ProjectAccountRowsSelection, signal?: AbortSignal, context?: ActionExecutorContext, effectActionId?: string) => ReturnType<typeof readProjectAccountRows>;
  readProjectRequesterArtifact: (ref: Parameters<NonNullable<ExternalActionExecutionAuthorizationV1['requesterAccountProjection']>['readArtifact']>[0], options: Readonly<{ signal?: AbortSignal }> | undefined, context: ActionExecutorContext) => ReturnType<NonNullable<ExternalActionExecutionAuthorizationV1['requesterAccountProjection']>['readArtifact']>;
}>;
export function createCliProjectAdmission(
  params: Pick<CliActionDepsParams, 'serverId' | 'serverIdentityId' | 'credentials' | 'serverHttpBaseUrl'>,
  { projectHomeId, actionHomeId, executionRunActionFailure }: Readonly<{
    projectHomeId: string;
    actionHomeId: string;
    executionRunActionFailure: (code: string, message?: string, details?: unknown) => CliProjectAdmissionFailure;
  }>,
): CliProjectAdmission {
  const resolveProjectHomeIdentity = async () => {
    const { resolveServerProfileHomeIdentityId } = await import("@/server/serverProfiles");
    return params.serverIdentityId ?? await resolveServerProfileHomeIdentityId(projectHomeId) ?? actionHomeId;
  };
  const projectHomeAdmission = async (serverId?: string, context?: ActionExecutorContext) => {
    const { isServerProfileHomeIdentity } = await import("@/server/serverProfiles");
    const isActionHome = (candidate: string) => params.serverIdentityId
      ? areServerProfileIdentifiersEquivalent(projectHomeId, candidate, identifier =>
        identifier === projectHomeId || identifier === params.serverIdentityId ? params.serverIdentityId : undefined)
      : isServerProfileHomeIdentity(projectHomeId, candidate);
    if ((serverId !== undefined && !await isActionHome(serverId.trim()))
      || (context?.serverId && !await isActionHome(context.serverId))
      || (params.serverId === undefined && configuration.activeServerId !== projectHomeId)) {
      return executionRunActionFailure('server_scope_mismatch');
    }
    return null;
  };
  const projectAccountAdmission = async (serverId?: string, context?: ActionExecutorContext) => {
    const homeDenied = await projectHomeAdmission(serverId, context);
    if (homeDenied) return homeDenied;
    const authorization = context?.externalActionExecutionAuthorization;
    if (authorization) {
      const account = authorization.requesterAccountProjection;
      const http = authorization.requesterHttpProjection;
      if (!account || !http || account.accountId !== authorization.binding.accountId || http.accountId !== account.accountId
        || account.serverId !== projectHomeId || http.serverId !== projectHomeId
        || http.serverHttpBaseUrl.replace(/\/+$/, '') !== (params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '')
        || context?.externalActionCredential && context.externalActionCredential.accountId !== account.accountId
        || context?.runtimeAccountId && context.runtimeAccountId !== account.accountId) {
        return executionRunActionFailure('project_requester_authority_unavailable');
      }
      return null;
    }
    // Public principal equality does not establish private requester custody.
    // External actions must arrive with the admitted host-private projection.
    if (context?.externalActionCredential) return executionRunActionFailure('project_requester_authority_unavailable');
    if (!params.credentials) return executionRunActionFailure('not_authenticated');
    const accountId = readAccountIdFromToken(params.credentials.token);
    if (context?.rpcSessionAuthorization && !context.runtimeAccountId) {
      return executionRunActionFailure('project_requester_authority_unavailable');
    }
    if (context?.runtimeAccountId && context.runtimeAccountId !== accountId) {
      return executionRunActionFailure('project_requester_authority_unavailable');
    }
    return null;
  };
  const withProjectHome = <T>(operation: () => Promise<T>): Promise<T> => runWithServerHttpBaseUrl(
    params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl(), operation,
  );
  const projectRowsAuthority = (context?: ActionExecutorContext, effectActionId?: string, signal?: AbortSignal): ProjectAccountRowsInput => {
    const authorization = context?.externalActionExecutionAuthorization;
    if (authorization) return { authorization, effectActionId: effectActionId ?? authorization.binding.actionId,
      serverId: projectHomeId, ...(signal ? { signal } : {}) };
    if (!params.credentials) throw Object.assign(new Error('not_authenticated'), { code: 'not_authenticated' });
    return { credentials: params.credentials, serverId: projectHomeId, ...(signal ? { signal } : {}) };
  };
  const assertProjectRequesterCurrent = async (context?: ActionExecutorContext) => {
    const authorization = context?.externalActionExecutionAuthorization;
    if (!authorization) return;
    if (await projectAccountAdmission(projectHomeId, context)
      || !await authorization.requesterAccountProjection!.isCurrent() || !await authorization.requesterHttpProjection!.isCurrent()) {
      throw Object.assign(new Error('project_requester_authority_unavailable'), { code: 'project_requester_authority_unavailable' });
    }
    context?.signal?.throwIfAborted();
  };
  const readProjectRows = async (selection: ProjectAccountRowsSelection, signal?: AbortSignal, context?: ActionExecutorContext, effectActionId?: string) => {
    const { readProjectAccountRows } = await import("@/workspaces/projectAccountRows");
    return await withProjectHome(() => readProjectAccountRows({ ...projectRowsAuthority(context, effectActionId, signal), selection }));
  };
  const readProjectRequesterArtifact = async (ref: Parameters<NonNullable<ExternalActionExecutionAuthorizationV1['requesterAccountProjection']>['readArtifact']>[0],
    options: Readonly<{ signal?: AbortSignal }> | undefined, context: ActionExecutorContext) => {
    const authorization = context.externalActionExecutionAuthorization;
    if (!authorization) return null;
    await assertProjectRequesterCurrent(context);
    const artifact = await authorization.requesterAccountProjection!.readArtifact(ref, { ...options, authorization });
    await assertProjectRequesterCurrent(context);
    return artifact?.artifactId === ref.artifactId ? artifact : null;
  };
  return { resolveProjectHomeIdentity, projectHomeAdmission, projectAccountAdmission, withProjectHome, projectRowsAuthority, assertProjectRequesterCurrent, readProjectRows, readProjectRequesterArtifact };
}

export type CliAdmittedProjectRowsReader = (selection: ProjectAccountRowsSelection, signal: AbortSignal | undefined, context: ActionExecutorContext | undefined, fallbackActionId: string) => Promise<Awaited<ReturnType<typeof readProjectAccountRows>> | null>;
export function createCliAdmittedProjectRowsReader(
  { widgetHomeId, projectAccountAdmission, readProjectRows, assertProjectRequesterCurrent }: Readonly<{
    widgetHomeId: string;
    projectAccountAdmission: CliProjectAdmission['projectAccountAdmission'];
    readProjectRows: CliProjectAdmission['readProjectRows'];
    assertProjectRequesterCurrent: CliProjectAdmission['assertProjectRequesterCurrent'];
  }>,
): CliAdmittedProjectRowsReader {

  // One admission for every read of the Account's Project rows by a widget input: the validator and the choices.
  const readAdmittedProjectRows = async (selection: ProjectAccountRowsSelection, signal: AbortSignal | undefined, context: ActionExecutorContext | undefined, fallbackActionId: string) => {
    if (await projectAccountAdmission(widgetHomeId, context)) return null;
    const rows = await readProjectRows(selection, signal, context, context?.externalActionExecutionAuthorization?.binding.actionId ?? fallbackActionId);
    await assertProjectRequesterCurrent(context);
    signal?.throwIfAborted();
    return await projectAccountAdmission(widgetHomeId, context) ? null : rows;
  };
  return readAdmittedProjectRows;
}
