import type { ActionExecutorDeps, ApprovalRequest, TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import { LIVE_CLI_APPROVAL_DECIDE_METHOD, readLiveCliApprovalOriginScope } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { isTargetApproval } from '@happier-dev/protocol/approvals/resolveApprovalExecutor';
import { ActionExecuteResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';

type Replay = Omit<Parameters<NonNullable<ActionExecutorDeps['approvalRequestApprovedReplay']>>[0], 'request'>
  & Readonly<{ request: ApprovalRequest | TargetActionApprovalRequestV1 }>;
export async function replayLiveCliApprovalOrigin(args: Replay, account: Readonly<{
  token: string; accountId: string | null; serverUrl: string; isCurrent(): Promise<boolean>;
}>): Promise<Awaited<ReturnType<NonNullable<ActionExecutorDeps['approvalRequestApprovedReplay']>>>> {
  const originScope = readLiveCliApprovalOriginScope(args.request);
  if (!originScope) return null;
  const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
  const { context, request, signal } = args;
  if (context.surface !== 'cli' || context.authority !== 'present_user'
    || context.actionCaller && context.actionCaller.kind !== 'host'
    || context.externalActionCredential || context.externalActionExecutionAuthorization || context.rpcSessionAuthorization
    || context.causalPermissionAuthority || context.callerInputConstraints) return fail('present_user_required');
  const origin = request.v === 2 || isTargetApproval(request) ? request.executionOriginV1 : undefined;
  if (!origin?.accountId || origin.accountId !== account.accountId
    || context.serverIdentityId && context.serverIdentityId !== origin.serverIdentityId) return fail('approval_stale');
  if (args.decision !== 'approve') return fail('approval_origin_unavailable');
  if (signal?.aborted) return fail('cancelled');
  if (!await account.isCurrent()) return fail('credential_scope_retired');
  const result = await runWithServerHttpBaseUrl(account.serverUrl, () => callSessionRpc({
    token: account.token, sessionId: originScope,
    method: LIVE_CLI_APPROVAL_DECIDE_METHOD, mode: 'plain', timeoutMs: null,
    request: { artifactId: args.artifactId, decision: 'approve', serverIdentityId: origin.serverIdentityId, originServerId: origin.serverId },
    ...(signal ? { signal } : {}), onIssued: () => args.onReplayDispatched?.(),
  }));
  if (!await account.isCurrent()) return fail('credential_scope_retired');
  const parsed = ActionExecuteResultSchema.safeParse(result);
  return parsed.success ? parsed.data : fail('invalid_action_transport_output');
}
