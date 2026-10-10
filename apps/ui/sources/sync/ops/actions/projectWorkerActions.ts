import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { ProjectWorkerActionOutputSchemasV1, type ProjectWorkerActionIdV1, type ProjectWorkerActionInputV1, type ProjectWorkerActionOutputV1 } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { randomUUID } from '@/platform/randomUUID';
import { withDefaultActionExecuteContext } from '@/sync/ops/actions/defaultActionExecutor';
import {
    awaitActionApprovalResult, createActionApprovalContinuation, type ActionApprovalRegistration,
} from '@/components/approvals/actionApprovalContinuation';

export type ProjectWorkerActionOptions = Readonly<{
    expectedAccountId?: string;
    signal?: AbortSignal;
    onApprovalPending?: (registration: ActionApprovalRegistration) => void;
}>;

export class ProjectWorkerActionError extends Error {
    constructor(readonly errorCode: string, readonly approvalArtifactId?: string, readonly details?: unknown) {
        super(errorCode);
        this.name = 'ProjectWorkerActionError';
    }
}

/** Settings controls consume the public Action front door, never the row HTTP port. */
export async function executeProjectWorkerActionV1<TActionId extends ProjectWorkerActionIdV1>(
    actionId: TActionId, input: ProjectWorkerActionInputV1<TActionId>, options?: ProjectWorkerActionOptions,
): Promise<ProjectWorkerActionOutputV1<TActionId>> {
    return await withDefaultActionExecuteContext(undefined, {
        serverId: 'workspace' in input ? input.workspace.serverId : input.serverId,
        ...(options?.expectedAccountId ? { expectedAccountId: options.expectedAccountId } : {}),
    }, async (executor, account) => {
        account.assertCurrent();
        type Receipt = Readonly<{ ok: true; value: ProjectWorkerActionOutputV1<TActionId> }>
            | Readonly<{ ok: false; error: ProjectWorkerActionError }>;
        const parseReceipt = (value: unknown): Receipt => ({ ok: true,
            value: ProjectWorkerActionOutputSchemasV1[actionId].parse(value) as ProjectWorkerActionOutputV1<TActionId> });
        const requestId = randomUUID();
        const receipt = await awaitActionApprovalResult<unknown, Receipt>({
            ...(options?.signal ? { signal: options.signal } : {}),
            execute: async (callbacks) => {
                const outcome = await executor.execute(actionId, input, {
                    surface: 'ui', serverId: account.serverId, runtimeAccountId: account.accountId,
                    actionRequestId: requestId, ...(options?.signal ? { signal: options.signal } : {}),
                });
                account.assertResultCurrent(getActionSpec(actionId).sideEffectClass);
                if (!outcome.ok) return { ok: false, error: new ProjectWorkerActionError(
                    outcome.errorCode ?? 'unsupported_action', undefined, outcome.details) };
                const approval = ActionApprovalRequestCreatedResultSchema.safeParse(outcome.result);
                if (!approval.success) return parseReceipt(outcome.result);
                if (!options?.onApprovalPending) throw new ProjectWorkerActionError('approval_required', approval.data.artifactId);
                options.onApprovalPending(createActionApprovalContinuation({
                    artifactId: approval.data.artifactId, actionId,
                    scope: { serverId: account.serverId, accountId: account.accountId },
                    expectedInput: input, expectedRequestId: requestId,
                    ...(options.signal ? { signal: options.signal } : {}),
                    onSucceeded: callbacks.onApprovalSucceeded, onFailed: callbacks.onApprovalFailed,
                }));
                return { approvalPending: true };
            },
            succeeded: parseReceipt,
            failed: (code, failure) => ({ ok: false, error: new ProjectWorkerActionError(code, undefined, failure?.details) }),
            aborted: () => ({ ok: false, error: new ProjectWorkerActionError('cancelled') }),
        });
        if (!receipt.ok) throw receipt.error;
        return receipt.value;
    }, actionId);
}
