import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions/executor/types';
import { createTargetActionApprovalDecision } from '@happier-dev/protocol/actions/targetActionApprovalDecision';
import { resolveApprovalExecutor } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { executeOriginalAccountMachineAction } from '@/sync/api/externalActionAccountTransport';
import { randomUUID } from '@/platform/randomUUID';
import type { LazyActionAccountContext } from './actionAccountContext';
import { resolveApprovalReplayRoute } from './approvalReplayRoute';

type DecisionDeps = Parameters<typeof createTargetActionApprovalDecision>[0];

/** Deliver a target decision to its canonical executor; only a retained local invocation spends local input. */
export function createUiTargetActionApprovalReplay(params: Readonly<{
    account: LazyActionAccountContext | null;
    read: DecisionDeps['read'];
    update: DecisionDeps['update'];
    hasLocalInvocation: (artifactId: string) => boolean;
}>): NonNullable<ActionExecutorDeps['targetActionApprovalReplay']> {
    const local = createTargetActionApprovalDecision({ read: params.read, update: params.update,
        hasLiveInvocation: params.hasLocalInvocation });
    return async args => {
        let request: Awaited<ReturnType<DecisionDeps['read']>>;
        try { request = await params.read(args.artifactId, args.initialRead); }
        catch { return { ok: false, errorCode: 'approval_context_unavailable', error: 'approval_context_unavailable' }; }
        if (!request) return null;
        const executor = resolveApprovalExecutor(request);
        if (executor.kind === 'live_invocation'
            && (!executor.daemonMachineId || params.hasLocalInvocation(args.artifactId))) {
            return local({ ...args, initialRead: { request } });
        }
        const machineId = executor.kind === 'daemon' ? executor.machineId
            : executor.kind === 'live_invocation' ? executor.daemonMachineId : null;
        const account = params.account;
        const context = args.context;
        if (!account || account.credentialAuthorityKind !== 'account'
            || !context || (context.surface !== 'ui' && context.surface !== 'voice') || context.authority !== 'present_user'
            || context.externalActionCredential || context.externalActionExecutionAuthorization || context.rpcSessionAuthorization
            || context.actionCaller && context.actionCaller.kind !== 'host') {
            return { ok: false, errorCode: 'present_user_required', error: 'present_user_required' };
        }
        const route = resolveApprovalReplayRoute(request);
        if (!machineId || !route || route.serverIdentityId !== account.serverIdentityId) {
            return { ok: false, errorCode: 'approval_origin_unavailable', error: 'approval_origin_unavailable' };
        }
        account.assertCurrent();
        const result = await executeOriginalAccountMachineAction({ account, machineId,
            actionId: 'approval.request.decide', requestId: context.actionRequestId ?? randomUUID(),
            input: { artifactId: args.artifactId, decision: args.decision,
                serverIdentityId: route.serverIdentityId, originServerId: route.originServerId },
            ...(args.signal ? { signal: args.signal } : {}),
        });
        account.assertResultCurrent(getActionSpec('approval.request.decide').sideEffectClass);
        return result ?? { ok: false, errorCode: 'approval_origin_unavailable', error: 'approval_origin_unavailable' };
    };
}
