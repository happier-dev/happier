import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ActionApprovalRequestCreatedResultSchema, ActionExecuteFailureSchema, isActionApprovalDeclinedErrorCode, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';
import { randomUUID } from '@/platform/randomUUID';
import { safeParse, type core } from 'zod/mini';
import { SCM_OPERATION_ERROR_CODES, ScmOperationErrorCodeSchema } from '@happier-dev/protocol/scm';
import type { ScmRpcFailure } from './scmRpcFailure';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

export type UiScmActionExecutor = Readonly<{
    execute: (actionId: ActionId, input: unknown, context?: UiActionExecutorContext) => Promise<ActionExecuteResult>;
}>;
export type UiScmActionFailure = Readonly<{
    success: false; errorCode: string; error: string; approvalArtifactId?: string;
}>;
const APPROVAL_REQUIRED = 'approval_required';

/** Legacy typed SCM facades retain their closed error vocabulary and approval handle. */
export function normalizeUiScmFacadeResult<T extends { success: boolean; error?: string; errorCode?: string }>(result: unknown): T | ScmRpcFailure {
    if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        const refusal = ActionExecuteFailureSchema.safeParse(result);
        if (refusal.success) result = { success: false, errorCode: refusal.data.errorCode, error: refusal.data.error };
    }
    // An approval request was created: the Action waits for someone to decide, which is neither a failure nor
    // a Git outcome. COMMAND_CANCELLED is only the closed-vocabulary placeholder; `awaitingApproval` is the authority.
    if (result && typeof result === 'object' && 'approvalArtifactId' in result && 'errorCode' in result && result.errorCode === APPROVAL_REQUIRED
        && typeof result.approvalArtifactId === 'string') {
        return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_CANCELLED, awaitingApproval: true,
            approvalArtifactId: result.approvalArtifactId, error: 'The Action awaits approval.' };
    }
    if (result && typeof result === 'object' && 'success' in result && result.success === false && 'errorCode' in result
        && !ScmOperationErrorCodeSchema.safeParse(result.errorCode).success) {
        const actionErrorCode = typeof result.errorCode === 'string' ? result.errorCode : undefined;
        const error = 'error' in result && typeof result.error === 'string' ? result.error : undefined;
        // A declined confirmation is the person's answer, not an unsupported Action. COMMAND_CANCELLED is the
        // closed-vocabulary placeholder (nothing ran, so it names no Git failure); `declined` is the authority.
        if (isActionApprovalDeclinedErrorCode(actionErrorCode)) {
            return { success: false, errorCode: SCM_OPERATION_ERROR_CODES.COMMAND_CANCELLED, declined: true,
                ...(actionErrorCode ? { actionErrorCode } : {}), error: error ?? 'The confirmation was declined.' };
        }
        // A response rejected by the Action's output contract is a failed command result,
        // not evidence that this Machine lacks the capability.
        return { ...result, success: false, errorCode: actionErrorCode === 'invalid_action_output'
            ? SCM_OPERATION_ERROR_CODES.COMMAND_FAILED : SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
            ...(actionErrorCode ? { actionErrorCode } : {}),
            error: error ?? 'The SCM Action is unavailable.' };
    }
    // invokeUiScmAction has validated domain outputs against the Action's declared schema.
    return result as T;
}

/**
 * The Action ran nothing and nothing failed: a present person declined its in-place confirmation, or an
 * approval request now waits for a decision. SCM presenters and mutation loggers treat it as no outcome at
 * all (no alert, banner, log entry or refresh); a waiting approval is announced once, by `invokeUiScmAction`.
 */
export function isScmActionNotRun(result: unknown): boolean {
    if (!result || typeof result !== 'object') return false;
    const flags = result as { declined?: unknown; awaitingApproval?: unknown };
    return flags.declined === true || flags.awaitingApproval === true;
}

/** The neutral pending notice for a created approval request, with a way to open it (the Home hub's pattern). */
async function announceScmApprovalPending(artifactId: string, serverId: string | undefined): Promise<void> {
    const [{ publishPresentationNotice }, { buildApprovalHref }, { t }, { getActiveServerAccountScope }] = await Promise.all([
        import('@/components/sessions/presentation/presentationNotices'),
        import('@/components/approvals/approvalNavigation'),
        import('@/text'),
        import('@/sync/domains/scope/activeServerAccountScope'),
    ]);
    const approvalServerId = serverId ?? getActiveServerAccountScope()?.serverId;
    publishPresentationNotice({
        key: `scm-approval:${artifactId}`, severity: 'info', message: t('approvals.waitingForYou'),
        ...(approvalServerId ? { undo: { label: t('approvals.review'), run: () => {
            void import('expo-router').then(({ router }) => router.push(buildApprovalHref(artifactId, approvalServerId)));
        } } } : {}),
    });
}

/** UI adapters enter the Action owner; only its admitted terminal calls SCM RPC. */
export async function invokeUiScmAction<T>(params: Readonly<{
    actionId: ActionId; input: unknown; schema: core.$ZodType<T>;
    context: UiActionExecutorContext; executor?: UiScmActionExecutor;
    shouldContinue?: () => boolean;
    /** Fires when the admitted Action is about to reach the Machine, after any in-place confirmation. */
    onDispatched?: () => void;
}>): Promise<T | UiScmActionFailure> {
    const current = () => !params.context.signal?.aborted && params.shouldContinue?.() !== false;
    const retired = (): UiScmActionFailure => ({ success: false, errorCode: params.context.signal?.aborted
        ? SCM_OPERATION_ERROR_CODES.COMMAND_CANCELLED : 'result_unavailable',
        error: 'The captured Account or SCM host retired.' });
    const effectClass = getActionSpec(params.actionId).sideEffectClass;
    const effectReceipt = effectClass === 'write' || effectClass === 'external' || effectClass === 'danger';
    if (!current()) return retired();
    try {
        const executor = params.executor ?? (await import('@/sync/ops/actions/defaultActionExecutor'))
            .createDefaultActionExecutor(params.onDispatched ? { onScmDispatched: params.onDispatched } : undefined);
        // `execute` is the run-now entry: it alone offers a present person the in-place
        // confirmation. Withdrawal before dispatch is the context signal; `shouldContinue`
        // is read before entry and, for non-receipt effects, after the result.
        const response = await executor.execute(params.actionId, params.input, {
            ...params.context, surface: 'ui', actionRequestId: randomUUID(),
        });
        if (!effectReceipt && !current()) return retired();
        if (!response.ok) return { success: false, errorCode: response.errorCode ?? 'result_unavailable', error: response.error };
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(response.result);
        if (approval.success) {
            await announceScmApprovalPending(approval.data.artifactId, params.context.serverId ?? undefined);
            return { success: false, errorCode: APPROVAL_REQUIRED,
                error: 'The Action awaits approval.', approvalArtifactId: approval.data.artifactId };
        }
        const parsed = safeParse(params.schema, response.result);
        return parsed.success ? parsed.data : { success: false, errorCode: 'invalid_action_output',
            error: 'The SCM Action response could not be validated.' };
    } catch (error) {
        if (!effectReceipt && !current()) return retired();
        return { success: false, errorCode: readRpcErrorCode(error) ?? 'result_unavailable',
            error: error instanceof Error ? error.message : 'The owning machine is unavailable.' };
    }
}
