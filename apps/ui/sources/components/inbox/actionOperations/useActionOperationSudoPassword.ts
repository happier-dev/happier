import * as React from 'react';
import { machineCapabilitiesInvoke } from '@/sync/ops/capabilities';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { actionOperationStore } from '@/sync/domains/actionOperations/actionOperationStore';
import { readActionOperationSudoPrompt } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { actionOperationAddressKey, type QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

type Submission = Readonly<{ ok: true }> | Readonly<{ ok: false; errorCode: string }>;

/** The password lives only in this transient call, never in an Action or UI store. */
export async function submitActionOperationSudoPassword(
    operation: QualifiedActionOperation,
    password: string,
    signal?: AbortSignal,
): Promise<Submission> {
    const question = readActionOperationSudoPrompt(operation.snapshot);
    const current = () => {
        const retained = actionOperationStore.getSnapshot().operationsByKey.get(actionOperationAddressKey({
            serverId: operation.serverId, operationId: operation.snapshot.operationId,
        }))?.snapshot;
        const domain = retained?.domainRef;
        const prompt = retained ? readActionOperationSudoPrompt(retained) : null;
        return question && retained && retained.actionId === operation.snapshot.actionId
            && retained.scope.accountId === operation.snapshot.scope.accountId
            && retained.scope.machineId === operation.snapshot.scope.machineId
            && (domain?.kind === 'machineSetup' || domain?.kind === 'machineReboot')
            && areServerProfileIdentifiersEquivalent(domain.serverId, operation.serverId)
            && prompt?.id === question.id && prompt.taskKind === question.taskKind
            && prompt.prompt.adminUsername === question.prompt.adminUsername;
    };
    if (!current()) return { ok: false, errorCode: 'action_operation_unavailable' };
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
        if (account.accountId !== operation.snapshot.scope.accountId || !current()) {
            return { ok: false, errorCode: 'action_operation_unavailable' };
        }
        const response = await machineCapabilitiesInvoke(operation.snapshot.scope.machineId, {
            id: 'tool.systemTasks', method: 'respond', params: {
                taskId: question!.id, expectedPromptKind: 'sudo.password', answer: { password },
            },
        }, { serverId: operation.serverId, accountId: account.accountId, signal: controller.signal });
        account.assertCurrent();
        if (!response.supported) return { ok: false, errorCode: response.errorCode ?? 'action_operation_unavailable' };
        return response.response.ok ? { ok: true } : { ok: false, errorCode: response.response.error.code ?? 'action_operation_unavailable' };
    } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined;
        return { ok: false, errorCode: controller.signal.aborted ? 'cancelled' : code ?? 'action_operation_unavailable' };
    } finally {
        retirement?.dispose();
        account?.dispose();
        signal?.removeEventListener('abort', cancel);
    }
}

/** Semantic control shared by setup and reboot; the detail surface owns rendering. */
export function useActionOperationSudoPassword(operation: QualifiedActionOperation | null | undefined) {
    const target = React.useMemo(() => operation ? readActionOperationSudoPrompt(operation.snapshot) : null, [operation?.snapshot]);
    const [pending, setPending] = React.useState(false);
    const [failureCode, setFailureCode] = React.useState<string | null>(null);
    const request = React.useRef<AbortController | null>(null);
    const key = JSON.stringify([operation?.serverId, operation?.snapshot.operationId, target?.id]);
    React.useEffect(() => {
        setPending(false);
        setFailureCode(null);
        return () => { request.current?.abort(); request.current = null; };
    }, [key]);
    const respond = React.useCallback(async (password: string): Promise<boolean> => {
        if (!operation || !target || request.current) return false;
        const controller = new AbortController();
        request.current = controller;
        setPending(true);
        setFailureCode(null);
        try {
            const result = await submitActionOperationSudoPassword(operation, password, controller.signal);
            if (controller.signal.aborted) return false;
            if (!result.ok) setFailureCode(result.errorCode);
            return result.ok;
        } finally {
            if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setPending(false); }
        }
    }, [operation, target]);
    return { target, pending, failureCode, respond };
}
