import { ActionExecuteFailureSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ExecutionRunHostActionApprovalSettlementV1Schema, StoredExecutionRunHostActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/executionRunHostActionApprovalRequestV1';
import type { ActionExecutorDeps } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { CliActionDepsParams } from '../cliActionDeps/types';
import type { StoredCredentials } from '@/persistence';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import { createCliApprovalsArtifactStore } from './artifactStore';

/** A deciding CLI delivers consent to the Session that owns the Run continuation. */
export function createExecutionRunHostApprovalReplay(params: Readonly<{
  credentials: StoredCredentials;
  serverId: string;
  serverHttpBaseUrl: string;
  isCurrent: () => Promise<boolean>;
  resolveServerFeaturesSnapshot?: CliActionDepsParams['resolveServerFeaturesSnapshot'];
}>): NonNullable<ActionExecutorDeps['executionRunHostActionApprovalReplay']> {
  const store = createCliApprovalsArtifactStore(params);
  const failure = (errorCode: string) => ({ ok: false as const, errorCode, error: errorCode });
  return async ({ artifactId, decision, initialRead, context, signal }) => runWithServerHttpBaseUrl(params.serverHttpBaseUrl, async () => {
    const parsed = initialRead ? StoredExecutionRunHostActionApprovalRequestV1Schema.safeParse(initialRead.request) : null;
    const request = initialRead ? parsed?.success ? parsed.data : null
      : await store.executionRunHostActionApprovalsGet({ artifactId });
    if (!request) return null;
    if (context?.surface !== 'cli' || context.authority !== 'present_user'
      || context.externalActionCredential || context.externalActionExecutionAuthorization || context.rpcSessionAuthorization
      || context.actionCaller && context.actionCaller.kind !== 'host') return failure('present_user_required');
    const assertCurrent = async () => {
      signal?.throwIfAborted();
      return await params.isCurrent();
    };
    if (!await assertCurrent()) return failure('credential_scope_retired');
    const transport = await resolveSessionTransportContext({ reason: 'session-action', credentials: params.credentials,
      idOrPrefix: request.sessionId, serverFeaturesSnapshot: await params.resolveServerFeaturesSnapshot?.(),
      ...(signal ? { signal } : {}) });
    if (!transport.ok || transport.sessionId !== request.sessionId) return failure('approval_origin_unavailable');
    if (!await assertCurrent()) return failure('credential_scope_retired');
    const raw = await callSessionRpc({ ...transport, token: params.credentials.token, sessionId: request.sessionId,
      method: `${request.sessionId}:${RPC_METHODS.APPROVAL_REQUEST_DECIDE}`,
      request: { artifactId, decision }, timeoutMs: null,
      ...(signal ? { signal } : {}),
    });
    if (!await assertCurrent()) return failure('credential_scope_retired');
    const result = ExecutionRunHostActionApprovalSettlementV1Schema.safeParse(raw);
    if (result.success) return { ok: true, result: result.data };
    const refused = ActionExecuteFailureSchema.safeParse(raw);
    return refused.success ? refused.data : failure('invalid_action_transport_output');
  });
}
