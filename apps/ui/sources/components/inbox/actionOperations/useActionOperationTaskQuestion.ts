import * as React from 'react';
import { executeDefaultActionInCapturedAccount } from '@/sync/ops/actions/defaultActionExecutor';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readActionOperationTaskQuestion } from '@/sync/domains/actionOperations/actionOperationSelectors';
import type { QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { ACTION_OPERATION_TASK_RESPOND_ACTION_ID_V1 } from '@happier-dev/protocol/actions/operations/actionIdsV1';

type Submission = Readonly<{ ok: true }> | Readonly<{ ok: false; errorCode: string }>;

/** Transient answers use the current task's authenticated Machine transport and owning Account lifetime. */
export async function submitActionOperationTaskAnswer(
    operation: QualifiedActionOperation,
    answer: Readonly<{ password: string }> | Readonly<{ trusted: boolean }>,
    signal?: AbortSignal,
): Promise<Submission> {
    const question = readActionOperationTaskQuestion(operation.snapshot);
    if (!question) return { ok: false, errorCode: 'action_operation_unavailable' };
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    let account: Awaited<ReturnType<typeof captureLazyActionAccountContext>> | undefined;
    let retirement: ReturnType<Awaited<ReturnType<typeof captureLazyActionAccountContext>>['accountLifetime']['onRetire']> | undefined;
    try {
        account = await captureLazyActionAccountContext(operation.serverId, controller.signal);
        retirement = account.accountLifetime.onRetire(cancel);
        account.assertCurrent();
        const response = await executeDefaultActionInCapturedAccount(account, ACTION_OPERATION_TASK_RESPOND_ACTION_ID_V1, {
            serverId: operation.serverId, machineId: operation.snapshot.scope.machineId,
            operationId: operation.snapshot.operationId, taskId: question.id, prompt: question.prompt, answer,
        }, { surface: 'ui', expectedAccountId: operation.snapshot.scope.accountId, signal: controller.signal });
        account.assertCurrent();
        return response.ok ? { ok: true } : { ok: false, errorCode: response.errorCode ?? 'action_operation_unavailable' };
    } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
        return { ok: false, errorCode: controller.signal.aborted ? 'cancelled' : code ?? 'action_operation_unavailable' };
    } finally {
        retirement?.dispose();
        account?.dispose();
        signal?.removeEventListener('abort', cancel);
    }
}

/** One response lifetime for setup, reboot and SSH trust; the question owns presentation. */
export function useActionOperationTaskQuestion(operation: QualifiedActionOperation | null | undefined) {
    const target = React.useMemo(() => operation ? readActionOperationTaskQuestion(operation.snapshot) : null, [operation?.snapshot]);
    const [pending, setPending] = React.useState(false);
    const [failureCode, setFailureCode] = React.useState<string | null>(null);
    const request = React.useRef<AbortController | null>(null);
    const key = JSON.stringify([operation?.serverId, operation?.snapshot.operationId, target?.id]);
    React.useEffect(() => {
        setPending(false);
        setFailureCode(null);
        return () => { request.current?.abort(); request.current = null; };
    }, [key]);
    const respond = React.useCallback(async (answer: Parameters<typeof submitActionOperationTaskAnswer>[1]): Promise<boolean> => {
        if (!operation || !target || request.current) return false;
        const controller = new AbortController();
        request.current = controller;
        setPending(true);
        setFailureCode(null);
        try {
            const result = await submitActionOperationTaskAnswer(operation, answer, controller.signal);
            if (controller.signal.aborted) return false;
            if (!result.ok) setFailureCode(result.errorCode);
            return result.ok;
        } finally {
            if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setPending(false); }
        }
    }, [operation, target]);
    return { target, pending, failureCode, respond };
}
