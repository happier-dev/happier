import { listAgentExecutionTargetsV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { SessionSpawnNewActionInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { SessionSpawnNewActionResultV1Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { readScmHostingRepositoryIdentity, sameScmHostingRepositoryIdentity } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { resolveWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { SessionSendMessageInputSchema } from '@happier-dev/protocol/actions/actionSpecs';
import { SessionMessageSendResultV1Schema } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { DeploymentPrepareResultV1Schema,
  type ActionExecutorDeps, type DeploymentPrepareInputV1 } from '@happier-dev/protocol';
import { dispatchOriginalAccountAction } from '@/api/externalActionExecutionAuthorization';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import type { StoredCredentials } from '@/persistence';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';
import { buildDeploymentPreparationBriefV1 } from '@happier-dev/protocol/deployments/deploymentPreparationV1';
import type { CliAdmittedProjectRowsReader } from '@/session/actions/cliActionDeps/projectAdmission';

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
      const rows = await host.readWorkspaceRows({ key: input.workspace }, context.signal, context, 'deployments.prepare');
      if (!rows) return fail('project_requester_authority_unavailable');
      const resolved = resolveWorkspaceRefV1(rows.workspaceRefs, { serverId: input.workspace.serverId, id: input.workspace.id });
      if (resolved.kind !== 'resolved') return { kind: 'refused', reason: 'workspace_unavailable' };
      const workspace = resolved.ref;
      if (workspace.source?.sourceId !== input.projectSourceId || workspace.source.revision !== input.sourceRevision
        || !sameScmHostingRepositoryIdentity(workspace.repositoryIdentity, input.repository)) return { kind: 'conflict', reason: 'source_changed' };
      if (host.machineId !== workspace.machineId) {
        // The originating Account routes the unchanged Prepare intent before native reads.
        if (authorization || host.machineId) return { kind: 'refused', reason: 'workspace_unavailable' };
        const routed = await dispatchOriginalAccountAction({ actionId: 'deployments.prepare', input,
          target: { kind: 'machine', machineId: workspace.machineId }, requestId: context.actionRequestId,
          credentials, serverHttpBaseUrl: host.serverHttpBaseUrl, serverIdentityId: host.serverIdentityId,
          authority: context.authority, invocation: { caller: { kind: 'host' }, surface: context.surface ?? 'cli',
            authority: context.authority ?? 'account_automation' }, isCurrent: current, signal: context.signal });
        if (!routed.ok) return routed;
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(routed.result);
        if (approval.success) return approval.data;
        const result = DeploymentPrepareResultV1Schema.safeParse(routed.result);
        return result.success ? result.data : fail('invalid_action_output');
      }
      if (context.externalActionTarget && (context.externalActionTarget.kind !== 'machine'
        || context.externalActionTarget.machineId !== workspace.machineId)) return fail('target_mismatch');
      const loaded = await host.readSource({ serverId: input.workspace.serverId, sourceId: input.projectSourceId }, context);
      if (!loaded.ok) return 'errorCode' in loaded ? loaded : { kind: 'refused', reason: 'access_denied' };
      const source = loaded.source;
      if (source.id !== input.projectSourceId || source.revision !== input.sourceRevision || !source.repository
        || !sameScmHostingRepositoryIdentity(readScmHostingRepositoryIdentity({ ...source.repository.provider,
          nameWithOwner: source.repository.repository.nameWithOwner }), input.repository)) return { kind: 'conflict', reason: 'source_changed' };
      const { inspectWorkspaceLocationWithScmWorkspace } = await import('@/scm/workspace/workspaceLocationInspection');
      const inspected = await inspectWorkspaceLocationWithScmWorkspace({ candidatePath: workspace.rootPath,
        includeRepositoryIdentity: true, signal: context.signal });
      if (!inspected) return { kind: 'refused', reason: 'workspace_unavailable' };
      if (inspected.inspection.committedRevision !== input.baseCommit) return { kind: 'conflict', reason: 'base_changed' };
      if (!sameScmHostingRepositoryIdentity(inspected.repositoryIdentity, input.repository)) return { kind: 'conflict', reason: 'source_changed' };
      if (!current()) return fail('cancelled');
      const signedCaller = Boolean(authorization?.binding.sessionActionOrigin || authorization?.binding.workflowActionOrigin);
      if (signedCaller && !executeCanonicalAction
        || authorization && !requester?.invocation) return fail('admission_unavailable');
      const childContext = {
        requestId: context.actionRequestId, credentials,
        serverHttpBaseUrl: host.serverHttpBaseUrl, serverIdentityId: host.serverIdentityId,
        authority: context.authority, ...(requester?.invocation ? { invocation: requester.invocation } : !authorization
          ? { invocation: { caller: { kind: 'host' as const }, surface: context.surface ?? 'cli', authority: context.authority ?? 'account_automation' } } : {}),
        isCurrent: current, signal: context.signal,
      };
      if (input.sessionRef) {
        const message = SessionSendMessageInputSchema.parse({ sessionId: input.sessionRef.sessionId,
          message: buildDeploymentPreparationBriefV1(input), reply: 'none' });
        const child = signedCaller && executeCanonicalAction
          ? await executeCanonicalAction('session.message.send', message)
          : await dispatchOriginalAccountAction({ ...childContext, actionId: 'session.message.send',
          target: { kind: 'session', sessionId: input.sessionRef.sessionId },
          input: message,
        });
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
      const [{ DEFAULT_AGENT_ID }, { readAgentCatalogSnapshot }] = await Promise.all([
        import('@happier-dev/agents/manifest'), import('@/agent/catalog/snapshot'),
      ]);
      const agent = readAgentCatalogSnapshot().agentDefinitionsById.get(DEFAULT_AGENT_ID);
      const agentTarget = agent?.identity ? listAgentExecutionTargetsV1(agent.identity)[0] : undefined;
      if (!agentTarget) return { kind: 'refused', reason: 'unavailable' };
      const spawn = SessionSpawnNewActionInputV2Schema.parse({
        executionTarget: { serverId: input.workspace.serverId, machineId: workspace.machineId },
        directory: { kind: 'path', path: workspace.rootPath }, agentTarget,
        initialInput: { text: buildDeploymentPreparationBriefV1(input) },
      });
      const child = signedCaller && executeCanonicalAction
        ? await executeCanonicalAction('session.spawn_new', spawn)
        : await dispatchOriginalAccountAction({ ...childContext, actionId: 'session.spawn_new', input: spawn,
          target: { kind: 'machine', machineId: workspace.machineId } });
      if (!child.ok) return child;
      const approval = ActionApprovalRequestCreatedResultSchema.safeParse(child.result);
      if (approval.success) return approval.data;
      const settled = SessionSpawnNewActionResultV1Schema.safeParse(child.result);
      if (!settled.success) return fail('invalid_action_output');
      if (settled.data.type === 'pending') return { kind: 'partial', reason: 'child_failed',
        childOperationRefs: settled.data.operation ? [settled.data.operation] : [] };
      if (settled.data.type !== 'success') return { kind: 'refused', reason: settled.data.code === 'cancelled' ? 'cancelled' : 'child_failed' };
      const sessionRef = { serverId: settled.data.executionTarget.serverId, sessionId: settled.data.sessionId };
      if (settled.data.executionTarget.machineId !== workspace.machineId
        || !await isServerProfileHomeIdentity(host.serverId, sessionRef.serverId))
        return { kind: 'partial', sessionRef, childOperationRefs: [], reason: 'input_changed' };
      return settled.data.initialInput.status === 'accepted' || settled.data.initialInput.status === 'alreadyAccepted'
        ? { kind: 'handedOff', sessionRef }
        : { kind: 'partial', sessionRef, childOperationRefs: [], reason: 'child_failed' };
    } catch (error) {
      if (context.signal?.aborted) return fail('cancelled');
      const code = readRpcErrorCode(error);
      return code ? fail(code) : { kind: 'refused', reason: 'unavailable' };
    }
  };
}
