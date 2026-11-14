import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionSendMessageInputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { DeploymentPrepareResultV1Schema, type DeploymentPrepareInputV1 } from '@happier-dev/protocol/deployments/deploymentPreparationV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { decodeJwtPayload, readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { projectExternalActionRequesterInvocationV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { StoredCredentials } from '@/persistence';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { buildDeploymentPreparationBriefV1, deriveDeploymentPrepareSessionSpawnInputV1 } from '@happier-dev/protocol/deployments/deploymentPreparationV1';
import type { CliAdmittedProjectRowsReader } from '@/session/actions/cliActionDeps/projectAdmission';
import { resolveAdmittedRepositoryWorkspace, validateAdmittedRepositoryWorkspace } from './admittedRepositoryWorkspace';
import { getPathRemainderWithinBase } from '@/session/handoff/paths/sessionHandoffPathNormalization';
import { expandHomeDirPath } from '@/utils/path/expandHomeDirPath';
import { projectDeploymentFailure } from '@/deployments/deploymentFailure';

type PrepareHost = Readonly<{
  serverId: string;
  serverIdentityId?: string;
  serverHttpBaseUrl: string;
  machineId?: string;
  credentials?: StoredCredentials;
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  readWorkspaceRows: CliAdmittedProjectRowsReader;
  readSource: NonNullable<ActionExecutorDeps['projectSourcesRead']>;
}>;

/** Finite handoff only; the existing Session Action remains the process and approval owner. */
export function createPrepareDeployment(host: PrepareHost): NonNullable<ActionExecutorDeps['deploymentPrepare']> {
  return async (input, context, executeCanonicalAction) => {
    const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
    if (!context.serverId || !context.runtimeAccountId || !context.actionRequestId
      || !await isServerProfileHomeIdentity(host.serverId, input.workspace.serverId)) return fail('admission_unavailable');
    if (input.sessionRef && !await isServerProfileHomeIdentity(host.serverId, input.sessionRef.serverId))
      return fail('server_scope_mismatch');
    const authorization = context.externalActionExecutionAuthorization;
    const requester = readRequesterAccountActionContext(authorization);
    if (authorization && (!requester || requester.authorization.token !== authorization.token
      || authorization.binding.actionId !== 'deployments.prepare'
      || authorization.binding.accountId !== context.runtimeAccountId
      || normalizeServerHttpBaseUrl(requester.serverHttpBaseUrl) !== normalizeServerHttpBaseUrl(host.serverHttpBaseUrl)
      || !await isServerProfileHomeIdentity(host.serverId, authorization.binding.serverIdentityId))) return fail('admission_unavailable');
    if (!authorization && (context.externalActionCredential || context.rpcSessionAuthorization
      || context.actionCaller && context.actionCaller.kind !== 'host')) return fail('admission_unavailable');
    const credentials = requester?.credentials ?? host.credentials;
    if (!credentials || readAccountIdFromToken(credentials.token) !== context.runtimeAccountId) return fail('admission_unavailable');
    const current = () => !context.signal?.aborted;
    try {
      if (!current()) return fail('cancelled');
      if (!(requester ? await requester.isCurrent()
        : host.isCredentialCurrent ? await host.isCredentialCurrent() : true)) return fail('action_forbidden');
      const resolved = await resolveAdmittedRepositoryWorkspace({ workspace: input.workspace, expected: input, context,
        readWorkspaceRows: host.readWorkspaceRows, fallbackActionId: 'deployments.prepare' });
      if (!('kind' in resolved) || resolved.kind !== 'resolved') return resolved;
      const workspace = resolved.workspace;
      if (host.machineId !== workspace.machineId) {
        // The originating Account routes the unchanged Prepare intent before native reads.
        if (authorization || host.machineId) return { kind: 'refused', reason: 'workspace_unavailable' };
        const target = { kind: 'machine' as const, machineId: workspace.machineId };
        const authentication = readAuthTokenProvenance(decodeJwtPayload(credentials.token), { allowLegacyHome: true })?.provenance.kind;
        const serverIdentityId = context.serverIdentityId ?? host.serverIdentityId;
        const invocation = authentication === 'account' || authentication === 'terminal'
          ? projectExternalActionRequesterInvocationV1({ actionId: 'deployments.prepare', context,
            account: { accountId: context.runtimeAccountId, serverId: context.serverId,
              ...(serverIdentityId ? { serverIdentityId } : {}) }, target, authentication: { kind: authentication } }) : null;
        if (!invocation) return fail('admission_unavailable');
        const routed = await dispatchOriginalAccountAction({ actionId: 'deployments.prepare', input,
          target, requestId: context.actionRequestId,
          credentials, serverHttpBaseUrl: host.serverHttpBaseUrl, serverIdentityId: host.serverIdentityId,
          authority: invocation.authority, invocation, isCurrent: current, signal: context.signal });
        if (!routed.ok) return routed;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(routed.result);
        if (approval.success) return approval.data;
        const result = DeploymentPrepareResultV1Schema.safeParse(routed.result);
        return result.success ? result.data : fail('invalid_action_output');
      }
      if (context.externalActionTarget && (context.externalActionTarget.kind !== 'machine'
        || context.externalActionTarget.machineId !== workspace.machineId)) return fail('target_mismatch');
      const validated = await validateAdmittedRepositoryWorkspace({ ...input, workspace, context, readSource: host.readSource });
      if (!('kind' in validated) || validated.kind !== 'validated') return validated;
      if (!current()) return fail('cancelled');
      if (!executeCanonicalAction) return fail('admission_unavailable');
      if (input.sessionRef) {
        const message = SessionSendMessageInputSchema.parse({ sessionId: input.sessionRef.sessionId,
          message: buildDeploymentPreparationBriefV1(input), reply: 'none' });
        const child = await executeCanonicalAction('session.message.send', message);
        if (!child.ok) return child;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(child.result);
        if (approval.success) return approval.data;
        const settled = SessionMessageSendResultV1Schema.safeParse(child.result);
        if (!settled.success) return fail('invalid_action_output');
        if (settled.data.status === 'outcomeUnknown') return fail('outcome_unknown');
        if (settled.data.status === 'rejected' || settled.data.status === 'failed' || settled.data.status === 'cancelled')
          return fail(settled.data.code);
        return settled.data.status === 'held'
          ? { kind: 'partial', sessionRef: input.sessionRef, childOperationRefs: [], reason: 'child_failed' }
          : { kind: 'handedOff', sessionRef: input.sessionRef };
      }
      // Public input parsing requires the Session-owned recipe unless continuing a Session.
      const draft = input.sessionDraft!;
      if (draft.executionTarget.machineId !== workspace.machineId
        || !await isServerProfileHomeIdentity(host.serverId, draft.executionTarget.serverId)
        || draft.directory.kind !== 'path'
        || getPathRemainderWithinBase(expandHomeDirPath(draft.directory.path), expandHomeDirPath(workspace.rootPath)) !== '')
        return { kind: 'conflict', reason: 'input_changed' };
      const spawn = deriveDeploymentPrepareSessionSpawnInputV1(input);
      if (!spawn) return fail('invalid_parameters');
      const child = await executeCanonicalAction('session.spawn_new', spawn);
      if (!child.ok) return child;
      const approval = ActionApprovalRequestCreatedResultSchema.safeParse(child.result);
      if (approval.success) return approval.data;
      const settled = SessionSpawnNewActionResultV1Schema.safeParse(child.result);
      if (!settled.success) return fail('invalid_action_output');
      if (settled.data.type === 'pending') return { kind: 'partial', reason: 'child_failed',
        childOperationRefs: settled.data.operation ? [settled.data.operation] : [] };
      if (settled.data.type !== 'success') return { ok: false, errorCode: settled.data.code, error: settled.data.code,
        details: settled.data,
        ...('effectAttempted' in settled.data && typeof settled.data.effectAttempted === 'boolean'
          ? { effectAttempted: settled.data.effectAttempted } : {}),
        ...('failureCause' in settled.data && settled.data.failureCause ? { failureCause: settled.data.failureCause } : {}) };
      const sessionRef = { serverId: settled.data.executionTarget.serverId, sessionId: settled.data.sessionId };
      if (settled.data.executionTarget.machineId !== workspace.machineId
        || !await isServerProfileHomeIdentity(host.serverId, sessionRef.serverId))
        return { kind: 'partial', sessionRef, childOperationRefs: [], reason: 'input_changed' };
      return settled.data.initialInput.status === 'accepted' || settled.data.initialInput.status === 'alreadyAccepted'
        ? { kind: 'handedOff', sessionRef }
        : { kind: 'partial', sessionRef, childOperationRefs: [], reason: 'child_failed' };
    } catch (error) {
      if (context.signal?.aborted) return fail('cancelled');
      const failure = normalizeActionExecutorThrownError(error, 'deployments.prepare');
      return projectDeploymentFailure(failure.errorCode, error, 'deployments.prepare');
    }
  };
}
