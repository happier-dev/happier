import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ActionPrepareResult } from '@happier-dev/protocol/actions/executor/types';
import type { UiActionExecutorContext } from '@/sync/ops/actions/defaultActionExecutor';
import { randomUUID } from '@/platform/randomUUID';
import type { z } from 'zod';
import { SCM_OPERATION_ERROR_CODES, ScmOperationErrorCodeSchema } from '@happier-dev/protocol/scm';
import type { ScmRpcFailure } from './scmRpcFailure';

export type UiScmActionExecutor = Readonly<{
    prepare: (actionId: ActionId, input: unknown, context?: UiActionExecutorContext) => Promise<ActionPrepareResult>;
}>;
export type UiScmActionFailure = Readonly<{
    success: false; errorCode: string; error: string; approvalArtifactId?: string;
}>;

/** Legacy typed SCM facades retain their closed error vocabulary and approval handle. */
export function normalizeUiScmFacadeResult<T extends { success: boolean; error?: string; errorCode?: string }>(result: unknown): T | ScmRpcFailure {
    if (result && typeof result === 'object' && 'success' in result && result.success === false && 'errorCode' in result
        && !ScmOperationErrorCodeSchema.safeParse(result.errorCode).success) {
        return { ...result, success: false, errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
            ...(typeof result.errorCode === 'string' ? { actionErrorCode: result.errorCode } : {}),
            error: 'error' in result && typeof result.error === 'string' ? result.error : 'The SCM Action is unavailable.' };
    }
    // invokeUiScmAction has validated domain outputs against the Action's declared schema.
    return result as T;
}

/** UI adapters enter the Action owner; only its admitted terminal calls SCM RPC. */
export async function invokeUiScmAction<T>(params: Readonly<{
    actionId: ActionId; input: unknown; schema: z.ZodType<T>;
    context: UiActionExecutorContext; executor?: UiScmActionExecutor;
    shouldContinue?: () => boolean;
}>): Promise<T | UiScmActionFailure> {
    const current = () => !params.context.signal?.aborted && params.shouldContinue?.() !== false;
    const retired = (): UiScmActionFailure => ({ success: false, errorCode: 'result_unavailable',
        error: 'The captured Account or SCM host retired.' });
    if (!current()) return retired();
    try {
        const executor = params.executor ?? (await import('@/sync/ops/actions/defaultActionExecutor')).createDefaultActionExecutor();
        const prepared = await executor.prepare(params.actionId, params.input, {
            ...params.context, surface: 'ui', actionRequestId: randomUUID(),
        });
        if (!current()) return retired();
        const response = prepared.kind === 'settled' ? prepared.result : await prepared.invocation.run();
        if (!current()) return retired();
        if (!response.ok) return { success: false, errorCode: response.errorCode ?? 'result_unavailable', error: response.error };
        const approval = ActionApprovalRequestCreatedResultSchema.safeParse(response.result);
        if (approval.success) return { success: false, errorCode: 'approval_required',
            error: 'The Action awaits approval.', approvalArtifactId: approval.data.artifactId };
        const parsed = params.schema.safeParse(response.result);
        return parsed.success ? parsed.data : { success: false, errorCode: 'invalid_action_output',
            error: 'The SCM Action response could not be validated.' };
    } catch (error) {
        return { success: false, errorCode: 'result_unavailable',
            error: error instanceof Error ? error.message : 'The owning machine is unavailable.' };
    }
}
