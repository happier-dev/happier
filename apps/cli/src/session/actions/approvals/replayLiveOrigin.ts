import type { ActionExecutorDeps, ApprovalRequest, TargetActionApprovalRequestV1 } from '@happier-dev/protocol';
import { LIVE_CLI_APPROVAL_DECIDE_METHOD, readLiveCliApprovalOriginScope } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { isTargetApproval } from '@happier-dev/protocol/approvals/resolveApprovalExecutor';
import { ActionExecuteResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';

type Replay = Omit<Parameters<NonNullable<ActionExecutorDeps['approvalRequestApprovedReplay']>>[0], 'request'>
  & Readonly<{ request: ApprovalRequest | TargetActionApprovalRequestV1 }>;
export async function replayLiveCliApprovalOrigin(args: Replay, account: Readonly<{
  token: string; serverUrl: string;
}>): Promise<Awaited<ReturnType<NonNullable<ActionExecutorDeps['approvalRequestApprovedReplay']>>>> {
  const originScope = readLiveCliApprovalOriginScope(args.request);
  if (!originScope) return null;
  const fail = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
  const { request, signal } = args;
  const origin = request.v === 2 || isTargetApproval(request) ? request.executionOriginV1 : undefined;
  if (args.decision !== 'approve') return fail('approval_origin_unavailable');
  if (signal?.aborted) return fail('cancelled');
  const result = await runWithServerHttpBaseUrl(account.serverUrl, () => callSessionRpc({
    token: account.token, sessionId: originScope,
    method: LIVE_CLI_APPROVAL_DECIDE_METHOD, mode: 'plain', timeoutMs: null,
    request: { artifactId: args.artifactId, decision: 'approve', serverIdentityId: origin?.serverIdentityId, originServerId: origin?.serverId },
    ...(signal ? { signal } : {}), onIssued: () => args.onReplayDispatched?.(),
  }));
  const parsed = ActionExecuteResultSchema.safeParse(result);
  return parsed.success ? parsed.data : fail('invalid_action_transport_output');
}
