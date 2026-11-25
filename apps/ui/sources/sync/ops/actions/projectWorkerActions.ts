import { ActionApprovalRequestCreatedResultSchema, type ActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { ProjectWorkerActionOutputSchemasV1, type ProjectWorkerActionIdV1, type ProjectWorkerActionInputV1, type ProjectWorkerActionOutputV1 } from '@happier-dev/protocol/actions/specs/projectWorkers';
import { randomUUID } from '@/platform/randomUUID';
import { executeDefaultActionInCapturedAccount } from '@/sync/ops/actions/defaultActionExecutor';
import { captureLazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import {
    awaitActionApprovalResult, createActionApprovalContinuation, type ActionApprovalRegistration,
} from '@/components/approvals/actionApprovalContinuation';

export type ProjectWorkerActionOptions = Readonly<{
    expectedAccountId?: string;
    signal?: AbortSignal;
    onApprovalPending?: (registration: ActionApprovalRegistration) => void;
}>;

export class ProjectWorkerActionError extends Error {
    constructor(readonly errorCode: string, readonly approvalArtifactId?: string, readonly details?: unknown,
        /** The owner's typed cause (phase, answering Machine's code), for Technical details. */
        readonly failureCause?: ActionFailureCauseV1) {
        super(errorCode);
        this.name = 'ProjectWorkerActionError';
    }
}

/** Settings controls consume the public Action front door, never the row HTTP port. */
export async function executeProjectWorkerActionV1<TActionId extends ProjectWorkerActionIdV1>(
    actionId: TActionId, input: ProjectWorkerActionInputV1<TActionId>, options?: ProjectWorkerActionOptions,
): Promise<ProjectWorkerActionOutputV1<TActionId>> {
    const account = await captureLazyActionAccountContext('workspace' in input ? input.workspace.serverId : input.serverId,
        options?.signal);
    try {
        account.assertCurrent();
        type Receipt = Readonly<{ ok: true; value: ProjectWorkerActionOutputV1<TActionId> }>
            | Readonly<{ ok: false; error: ProjectWorkerActionError }>;
        const parseReceipt = (value: unknown): Receipt => ({ ok: true,
            value: ProjectWorkerActionOutputSchemasV1[actionId].parse(value) as ProjectWorkerActionOutputV1<TActionId> });
        const requestId = randomUUID();
        const receipt = await awaitActionApprovalResult<unknown, Receipt>({
            ...(options?.signal ? { signal: options.signal } : {}),
            execute: async (callbacks) => {
                const outcome = await executeDefaultActionInCapturedAccount(account, actionId, input, {
                    surface: 'ui',
                    ...(options?.expectedAccountId ? { expectedAccountId: options.expectedAccountId } : {}),
                    actionRequestId: requestId, ...(options?.signal ? { signal: options.signal } : {}),
                });
                if (!outcome.ok) return { ok: false, error: new ProjectWorkerActionError(
                    outcome.errorCode ?? 'unsupported_action', undefined, outcome.details, outcome.failureCause) };
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
            failed: (code, failure) => {
                // These settings callers already own conflict/unknown/locked UX.
                // Preserve their native receipt without treating it as approval success.
                const isSettingMutation = actionId === 'machines.worker.policy.set'
                    || actionId === 'projects.worker.preferences.set'
                    || actionId === 'projects.worker.preferences.reset'
                    || actionId === 'projects.service.placement.set';
                if (isSettingMutation) {
                    const output = ProjectWorkerActionOutputSchemasV1[actionId].safeParse(failure?.details);
                    if (output.success && 'status' in output.data && output.data.status === code) {
                        return parseReceipt(output.data);
                    }
                }
                return { ok: false, error: new ProjectWorkerActionError(code, undefined, failure?.details, failure?.failureCause) };
            },
            aborted: () => ({ ok: false, error: new ProjectWorkerActionError('cancelled') }),
        });
        if (!receipt.ok) throw receipt.error;
        return receipt.value;
    } finally { account.dispose(); }
}
