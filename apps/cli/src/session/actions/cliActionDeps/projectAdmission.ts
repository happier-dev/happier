import type { CliActionDepsParams } from './types';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { type ExternalActionExecutionAuthorizationV1 } from '@happier-dev/protocol/actions/externalActionApi';
import type { readProjectAccountRows, ProjectAccountRowsInput, ProjectAccountRowsSelection } from '@/workspaces/projectAccountRows';
import { createCliMachineActionServerScopeCurrent } from './machineTransport';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readRetainedVerifiedExternalActionRequester } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { isManagedControllerCodecActionV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { logger } from '@/ui/logger';
export type CliProjectAdmissionFailure = Readonly<{ ok: false; errorCode: string; error: string; details?: unknown }>;
type CliProjectRowsAdmission = CliProjectAdmissionFailure | Readonly<{ ok: true; input: ProjectAccountRowsInput; assertCurrent: () => Promise<void> }>;
type RequesterArtifactReadOptions = Omit<NonNullable<Parameters<NonNullable<ExternalActionExecutionAuthorizationV1['requesterAccountProjection']>['readArtifact']>[1]>, 'authorization'>;
export type CliProjectAdmission = Readonly<{
  resolveProjectHomeIdentity: () => Promise<string>;
  projectHomeAdmission: (serverId?: string, context?: ActionExecutorContext) => Promise<CliProjectAdmissionFailure | null>;
  projectAccountAdmission: (serverId?: string, context?: ActionExecutorContext) => Promise<CliProjectAdmissionFailure | null>;
  admitProjectRows: (serverId: string, context: ActionExecutorContext | undefined, effectActionId: string, signal?: AbortSignal) => Promise<CliProjectRowsAdmission>;
  withProjectHome: <T>(operation: () => Promise<T>) => Promise<T>;
  projectRowsAuthority: (context?: ActionExecutorContext, effectActionId?: string, signal?: AbortSignal) => ProjectAccountRowsInput;
  assertProjectRequesterCurrent: (context?: ActionExecutorContext) => Promise<void>;
  readProjectRows: (selection: ProjectAccountRowsSelection, signal?: AbortSignal, context?: ActionExecutorContext, effectActionId?: string) => ReturnType<typeof readProjectAccountRows>;
  readProjectRequesterArtifact: (ref: Parameters<NonNullable<ExternalActionExecutionAuthorizationV1['requesterAccountProjection']>['readArtifact']>[0], options: RequesterArtifactReadOptions | undefined, context: ActionExecutorContext) => ReturnType<NonNullable<ExternalActionExecutionAuthorizationV1['requesterAccountProjection']>['readArtifact']>;
}>;
export function createCliProjectAdmission(
  params: Pick<CliActionDepsParams, 'serverId' | 'serverIdentityId' | 'credentials' | 'serverHttpBaseUrl' | 'machineActionDirectTargetTransport'>,
  { projectHomeId, actionHomeId, executionRunActionFailure }: Readonly<{
    projectHomeId: string;
    actionHomeId: string;
    executionRunActionFailure: (code: string, message?: string, details?: unknown) => CliProjectAdmissionFailure;
  }>,
): CliProjectAdmission {
  const isMachineActionServerScopeCurrent = createCliMachineActionServerScopeCurrent(params);
  const resolveProjectHomeIdentity = async () => {
    const { resolveServerProfileHomeIdentityId } = await import("@/server/serverProfiles");
    return params.serverIdentityId ?? await resolveServerProfileHomeIdentityId(projectHomeId) ?? actionHomeId;
  };
  const projectHomeAdmission = async (serverId?: string, context?: ActionExecutorContext) => {
    // Consume the transport's Home decision, including the creator's profile
    // label retained by an approved replay on this exact local Machine.
    const isActionHome = (candidate: string) => candidate.length > 0 && isMachineActionServerScopeCurrent({
      serverId: candidate, machineId: context?.executionRunTargetMachineId, context, signal: context?.signal,
    });
    if ((serverId !== undefined && !await isActionHome(serverId.trim()))
      || (context?.serverId && context.serverId !== serverId?.trim() && !await isActionHome(context.serverId))
      || (params.serverId === undefined && configuration.activeServerId !== projectHomeId)) {
      return executionRunActionFailure('server_scope_mismatch');
    }
    return null;
  };
  // The four fixed reasons share one public refusal code.
  const refuseRequester = (reason: 'signed_root_projection' | 'external_credential_without_root'
    | 'rpc_session_without_account' | 'runtime_account_mismatch') => {
    logger.infoFile('[ProjectAdmission] requester authority refused', { reason });
    return executionRunActionFailure('project_requester_authority_unavailable', undefined, { reason });
  };
  const projectAccountAdmission = async (serverId?: string, context?: ActionExecutorContext) => {
    const homeDenied = await projectHomeAdmission(serverId, context);
    if (homeDenied) return homeDenied;
    const authorization = context?.externalActionExecutionAuthorization;
    if (authorization) {
      const account = authorization.requesterAccountProjection;
      const http = authorization.requesterHttpProjection;
      const accountId = authorization.binding.accountId;
      // Native credential-free roots retain installed signed HTTP custody, not
      // Account content keys. An arbitrary HTTP projection cannot select this path.
      const credentialFree = !account && readRetainedVerifiedExternalActionRequester(authorization)
        && isManagedControllerCodecActionV1(authorization.binding);
      if (!account && !credentialFree || !http || http.accountId !== accountId
        || account && (account.accountId !== accountId || account.serverId !== projectHomeId)
        || http.serverId !== projectHomeId
        || http.serverHttpBaseUrl.replace(/\/+$/, '') !== (params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()).replace(/\/+$/, '')
        || context?.externalActionCredential && context.externalActionCredential.accountId !== accountId
        || context?.runtimeAccountId && context.runtimeAccountId !== accountId) {
        return refuseRequester('signed_root_projection');
      }
      return null;
    }
    // Public principal equality does not establish private requester custody.
    // External actions must arrive with the admitted host-private projection.
    if (context?.externalActionCredential) return refuseRequester('external_credential_without_root');
    if (!params.credentials) return executionRunActionFailure('not_authenticated');
    const accountId = readAccountIdFromToken(params.credentials.token);
    if (context?.rpcSessionAuthorization && !context.runtimeAccountId) return refuseRequester('rpc_session_without_account');
    if (context?.runtimeAccountId && context.runtimeAccountId !== accountId) return refuseRequester('runtime_account_mismatch');
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
  const assertProjectRequesterCustodyCurrent = async (context?: ActionExecutorContext) => {
    const authorization = context?.externalActionExecutionAuthorization;
    if (authorization && (authorization.requesterAccountProjection && !await authorization.requesterAccountProjection.isCurrent()
      || !await authorization.requesterHttpProjection!.isCurrent())) {
      throw Object.assign(new Error('project_requester_authority_unavailable'), { code: 'project_requester_authority_unavailable' });
    }
    context?.signal?.throwIfAborted();
  };
  const assertProjectRequesterCurrent = async (context?: ActionExecutorContext) => {
    if (!context?.externalActionExecutionAuthorization) return;
    const denied = await projectAccountAdmission(projectHomeId, context);
    if (denied) {
      throw createActionExecuteFailureError(executionRunActionFailure('project_requester_authority_unavailable', undefined, denied.details));
    }
    await assertProjectRequesterCustodyCurrent(context);
  };
  const admitProjectRows: CliProjectAdmission['admitProjectRows'] = async (serverId, context, effectActionId, signal) => {
    const denied = await projectAccountAdmission(serverId, context);
    return denied ?? { ok: true, input: projectRowsAuthority(context, effectActionId, signal),
      assertCurrent: () => assertProjectRequesterCustodyCurrent(context) };
  };
  const readProjectRows = async (selection: ProjectAccountRowsSelection, signal?: AbortSignal, context?: ActionExecutorContext, effectActionId?: string) => {
    const { readProjectAccountRows } = await import("@/workspaces/projectAccountRows");
    return await withProjectHome(() => readProjectAccountRows({ ...projectRowsAuthority(context, effectActionId, signal), selection }));
  };
  const readProjectRequesterArtifact = async (ref: Parameters<NonNullable<ExternalActionExecutionAuthorizationV1['requesterAccountProjection']>['readArtifact']>[0],
    options: RequesterArtifactReadOptions | undefined, context: ActionExecutorContext) => {
    const authorization = context.externalActionExecutionAuthorization;
    if (!authorization) return null;
    await assertProjectRequesterCurrent(context);
    const artifact = await authorization.requesterAccountProjection!.readArtifact(ref, { ...options, authorization });
    await assertProjectRequesterCurrent(context);
    return artifact?.artifactId === ref.artifactId ? artifact : null;
  };
  return { resolveProjectHomeIdentity, projectHomeAdmission, projectAccountAdmission, admitProjectRows, withProjectHome, projectRowsAuthority, assertProjectRequesterCurrent, readProjectRows, readProjectRequesterArtifact };
}

export type CliAdmittedProjectRowsReader = (selection: ProjectAccountRowsSelection, signal: AbortSignal | undefined, context: ActionExecutorContext | undefined, fallbackActionId: string) => Promise<Awaited<ReturnType<typeof readProjectAccountRows>> | null>;
export function createCliAdmittedProjectRowsReader(
  { widgetHomeId, admitProjectRows, withProjectHome }: Readonly<{
    widgetHomeId: string;
    admitProjectRows: CliProjectAdmission['admitProjectRows'];
    withProjectHome: CliProjectAdmission['withProjectHome'];
  }>,
): CliAdmittedProjectRowsReader {

  // Admit the finite row read once; the row owner retains HTTP and custody checks.
  const readAdmittedProjectRows = async (selection: ProjectAccountRowsSelection, signal: AbortSignal | undefined, context: ActionExecutorContext | undefined, fallbackActionId: string) => {
    const admitted = await admitProjectRows(widgetHomeId, context, context?.externalActionExecutionAuthorization?.binding.actionId ?? fallbackActionId, signal);
    if (!admitted.ok) return null;
    const { readProjectAccountRows } = await import("@/workspaces/projectAccountRows");
    const rows = await withProjectHome(() => readProjectAccountRows({ ...admitted.input, selection }));
    signal?.throwIfAborted();
    return rows;
  };
  return readAdmittedProjectRows;
}
