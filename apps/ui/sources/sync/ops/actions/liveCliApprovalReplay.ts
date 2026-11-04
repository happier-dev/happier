import { callSocketRpc } from '@happier-dev/sync-client';
import { ActionExecuteResultSchema, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { LIVE_CLI_APPROVAL_DECIDE_METHOD, readLiveCliApprovalOriginScope } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { readCredentialAuthorityKind } from '@/auth/context/credentialAuthority';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { createEphemeralServerSocketClient } from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';
import { createScopedSocketConnectParams } from '@/sync/runtime/orchestration/serverScopedRpc/createScopedSocketConnectParams';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { throwIfAborted } from '@/utils/runtime/abortSignals';
import { withActionAccountRequestSignal, type LazyActionAccountContext } from './actionAccountContext';

type ReplayInput = Parameters<NonNullable<ActionExecutorDeps['approvalRequestApprovedReplay']>>[0];

/** Deliver consent to the live terminal that owns private Account input; no private operands cross this relay. */
export async function replayLiveCliApproval(params: ReplayInput & Readonly<{
    account: LazyActionAccountContext | null;
}>): Promise<ActionExecuteResult | null> {
    const { request, account, context } = params;
    const originScope = request.v === 2 ? readLiveCliApprovalOriginScope(request) : null;
    if (request.v !== 2 || params.decision === 'reject' || params.decision === 'cancel' || !originScope) return null;
    if (!account || account.credentialAuthorityKind !== 'account'
        || (context.surface !== 'ui' && context.surface !== 'voice') || context.authority !== 'present_user'
        || context.externalActionCredential || context.externalActionExecutionAuthorization || context.rpcSessionAuthorization
        || context.actionCaller && context.actionCaller.kind !== 'host') {
        return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
    }
    const origin = request.executionOriginV1;
    if (origin.accountId !== account.accountId || origin.serverIdentityId !== account.serverIdentityId) {
        return { ok: false, errorCode: 'approval_stale', error: 'approval_stale' };
    }
    return await withActionAccountRequestSignal(account, params.signal, async signal => {
        const assertCurrent = () => {
            throwIfAborted(signal);
            account.assertCurrent();
        };
        assertCurrent();
        return await runWithServerRequestAuthorityForServerAccountScope<ActionExecuteResult>({ scope: account.accountLifetime.scope,
            activeRequest: account.request, ...(signal ? { signal } : {}) }, async authority => {
            assertCurrent();
            if (readCredentialAuthorityKind(authority.context.token) !== 'account') {
                return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
            }
            const socket = await createEphemeralServerSocketClient({
                ...createScopedSocketConnectParams(authority.context, authority.transferCarrierCustody),
                ...(signal ? { signal } : {}),
            });
            try {
                assertCurrent();
                const raw = await callSocketRpc<unknown>({ socket, randomBytes: getRandomBytes,
                    target: { kind: 'machine', id: originScope },
                    method: LIVE_CLI_APPROVAL_DECIDE_METHOD,
                    params: { artifactId: params.artifactId, decision: 'approve',
                        serverIdentityId: origin.serverIdentityId, originServerId: origin.serverId },
                    content: { mode: 'plain' }, timeoutMs: null, signal,
                    onIssued: () => { assertCurrent(); params.onReplayDispatched?.(); },
                });
                // The shared ACK owner settles invocation cancellation. Keep its receipt while
                // still refusing disclosure after an Account switch.
                account.assertAccountCurrent();
                const result = ActionExecuteResultSchema.safeParse(raw);
                return result.success ? result.data
                    : { ok: false, errorCode: 'invalid_action_transport_output', error: 'invalid_action_transport_output' };
            } finally { socket.disconnect(); }
        });
    });
}
