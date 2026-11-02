import type { ActionExecutorContext, ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import type { ApiMachineClient } from '@/api/apiMachine';
import type { CurrentMachineExecutionOriginContext } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import type { StoredCredentials } from '@/persistence';
import { readApprovedWorkflowDiscussionPublication, type ApprovedDiscussionSourceActionExecute } from './approvedDiscussionPublication';
import type { createDiscussionActionDeps } from './discussionActionDeps';

/** The daemon's exact Workflow replay admission and publication, with no Session authority. */
export function createApprovedWorkflowDiscussionPublisher(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  serverId: string;
  serverUrl: string;
  callerAuthority?: ActionExecutorContext['authority'];
  isApprovalExecutionOriginCurrent?: ActionExecutorDeps['isApprovalExecutionOriginCurrent'];
  resolveCurrentMachineExecutionOriginContext?: (signal?: AbortSignal) => Promise<CurrentMachineExecutionOriginContext | null>;
  executeSourceAction: ApprovedDiscussionSourceActionExecute;
  getClient: () => Pick<ApiMachineClient, 'postAgentDiscussionMessage'> | null | undefined;
}>): NonNullable<Parameters<typeof createDiscussionActionDeps>[0]['postWorkflowMessage']> {
  return async (request, options) => {
    const context = options.context;
    const marker = context.discussionReplyReturn;
    const denied = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
    if (!context.approvedActionReplay?.artifactId) return denied('discussion_replay_approval_missing');
    if (params.callerAuthority !== 'present_user') return denied('present_user_required');
    if (!marker) return denied('discussion_replay_context_return_missing');
    if (!('kind' in marker) || marker.kind !== 'workflow_invocation') return denied('discussion_replay_context_return_invalid');
    if (!params.isApprovalExecutionOriginCurrent) return denied('discussion_replay_approval_context_missing');
    const current = await params.resolveCurrentMachineExecutionOriginContext?.(options.signal);
    if (!current) return denied('discussion_replay_machine_context_unavailable');
    if (current.machineId !== params.machineId) return denied('discussion_replay_current_machine_mismatch');
    if (current.serverIdentityId !== marker.serverId) return denied('discussion_replay_current_home_mismatch');
    const publication = await readApprovedWorkflowDiscussionPublication({
      artifactId: context.approvedActionReplay.artifactId, request, content: options.content,
      credentials: params.credentials, machineId: params.machineId, serverId: params.serverId, serverUrl: params.serverUrl,
      callerAuthority: params.callerAuthority,
      executeSourceAction: params.executeSourceAction,
      isApprovalExecutionOriginCurrent: params.isApprovalExecutionOriginCurrent,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const client = params.getClient();
    if (!publication.ok) return publication;
    if (!client) return denied('discussion_replay_machine_client_unavailable');
    return await client.postAgentDiscussionMessage(publication.value, options.signal ? { signal: options.signal } : undefined);
  };
}
