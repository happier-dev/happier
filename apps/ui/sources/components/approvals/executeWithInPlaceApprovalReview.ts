import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { isActionApprovalDeclinedErrorCode } from '@happier-dev/protocol/actions/actionExecutionResult';

import { Modal } from '@/modal';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

import { showApprovalReview } from './ApprovalReviewInPlace';

/** A runtime-owned UI invocation uses the same review as mounted Action controls. */
export async function executeWithInPlaceApprovalReview<TResult>(input: Readonly<{
    actionId: ActionId;
    signal?: AbortSignal;
    /** Declining or closing the review withdraws preparation through its normal Stop owner. */
    onDismissed(): void;
    execute(executor: NonNullable<Parameters<typeof createFrontDoorActionExecute>[0]>, signal: AbortSignal): Promise<TResult>;
}>): Promise<TResult> {
    const dismissal = new AbortController();
    const cancellation = mergeAbortSignals([input.signal, dismissal.signal]);
    let modalId: string | null = null;
    const close = () => {
        if (modalId === null) return;
        Modal.hide(modalId);
        modalId = null;
    };
    cancellation.signal.addEventListener('abort', close, { once: true });
    const execute = createFrontDoorActionExecute(undefined, {
        hostActionApprovalLifetime: { actionId: input.actionId, signal: cancellation.signal, surface: 'ui' },
        onBlockingApprovalPending: ({ artifactId, scope }) => {
            if (cancellation.signal.aborted) return;
            close();
            let answered = false;
            modalId = showApprovalReview({ artifactId, serverId: scope.serverId,
                onDecisionRecorded: () => { answered = true; },
                onDismissed: () => {
                    close();
                    if (answered || cancellation.signal.aborted) return;
                    // Stop fences the runtime before withdrawing its retained Action.
                    try { input.onDismissed(); } finally { dismissal.abort(); }
                },
            });
        },
    });
    try {
        return await input.execute({ execute: async (...args) => {
            const result = await execute(...args);
            // The coordinator settles before the review's recorded-decision callback.
            // Stop here so a person's refusal never becomes the runtime's failure.
            if (!cancellation.signal.aborted && !result.ok && isActionApprovalDeclinedErrorCode(result.errorCode)) input.onDismissed();
            return result;
        } }, cancellation.signal);
    } finally {
        cancellation.signal.removeEventListener('abort', close);
        cancellation.dispose();
        close();
    }
}
