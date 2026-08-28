import type { ActionExecutorContext, SessionHandoffWorkspaceTransfer } from '@happier-dev/protocol';

import { Modal } from '@/modal';
import { t } from '@/text';
import { openSessionHandoffProgressModal } from '@/components/sessions/handoff/openSessionHandoffProgressModal';
import { openSessionHandoffFailureRecoveryModal } from '@/components/sessions/handoff/openSessionHandoffFailureRecoveryModal';

import { executeSessionHandoffAction } from './executeSessionHandoffAction';
import { subscribeActionOperationByRequest } from '@/sync/domains/actionOperations/subscribeActionOperationByRequest';
import { performSessionHandoffRecoveryAction } from '../../ops/sessionHandoffs';
import { sync } from '@/sync/sync';
import { randomUUID } from '@/platform/randomUUID';

type ExecuteAction = (actionId: 'session.handoff', input: unknown, context?: ActionExecutorContext) => Promise<unknown>;

export type RunSessionHandoffUiFlowArgs = Readonly<{
    execute: ExecuteAction;
    sessionId: string;
    targetMachineId: string;
    targetPath?: string;
    targetSessionStorageMode?: 'direct' | 'persisted';
    workspaceTransfer?: SessionHandoffWorkspaceTransfer;
    context: ActionExecutorContext;
}>;

export type RunSessionHandoffUiFlowResult =
    | Readonly<{ ok: true; handoffId: string }>
    | Readonly<{ ok: false; handled: true }>;

function normalizeErrorMessage(value: unknown): string {
    if (typeof value === 'string' && value.trim()) return value;
    return t('sessionHandoff.failure.message');
}

function buildSessionHandoffRecoveryPresentation(
    error: unknown,
    recovery: Readonly<{ actions?: readonly string[] }>,
): Readonly<{
    title: string;
    message: string;
    details: string;
}> {
    if (recovery.actions?.includes('retry_source_cleanup')) {
        return {
            title: t('sessionHandoff.failure.title'),
            message: t('sessionHandoff.failure.message'),
            details: normalizeErrorMessage(error),
        };
    }
    return {
        title: t('sessionHandoff.recovery.title'),
        message: t('sessionHandoff.recovery.messageAfterSourceStop'),
        details: normalizeErrorMessage(error),
    };
}

export async function runSessionHandoffUiFlow(
    args: RunSessionHandoffUiFlowArgs,
): Promise<RunSessionHandoffUiFlowResult> {
    while (true) {
        const actionRequestId = randomUUID();
        const modalId = openSessionHandoffProgressModal();
        const unsubscribeProgress = subscribeActionOperationByRequest({
            actionId: 'session.handoff',
            requestId: actionRequestId,
            sessionId: args.sessionId,
            onUpdate: (operation) => {
            Modal.update(modalId, {
                operation,
            });
            },
        });
        let progressModalClosed = false;
        const closeProgressModal = () => {
            if (progressModalClosed) {
                return;
            }
            unsubscribeProgress();
            Modal.hide(modalId);
            progressModalClosed = true;
        };
        try {
            const releaseUserRequestLease = sync.acquireUserRequestLease();
            let result: Awaited<ReturnType<typeof executeSessionHandoffAction>>;
            try {
                result = await executeSessionHandoffAction({
                    ...args,
                    context: { ...args.context, actionRequestId },
                } as any);
            } finally {
                releaseUserRequestLease();
            }
            if (result.ok) {
                return result;
            }
            if (result.recovery) {
                closeProgressModal();
                let recoveryError = result.error;
                while (true) {
                    const recoveryPresentation = buildSessionHandoffRecoveryPresentation(
                        recoveryError,
                        result.recovery as any,
                    );
                    const action = await openSessionHandoffFailureRecoveryModal({
                        title: recoveryPresentation.title,
                        message: recoveryPresentation.message,
                        details: recoveryPresentation.details,
                        recovery: result.recovery as any,
                    });
                    if (!action) {
                        return { ok: false, handled: true };
                    }
                    let recoveryResult: Awaited<
                        ReturnType<typeof performSessionHandoffRecoveryAction>
                    >;
                    try {
                        recoveryResult = await performSessionHandoffRecoveryAction({
                            recovery: result.recovery as any,
                            action,
                        });
                    } catch (error) {
                        recoveryError = normalizeErrorMessage(
                            error instanceof Error ? error.message : error,
                        );
                        continue;
                    }
                    if (recoveryResult.ok) {
                        return { ok: false, handled: true };
                    }
                    recoveryError = normalizeErrorMessage(recoveryResult.error);
                }
            }

            const shouldRetry = await Modal.confirm(
                t('sessionHandoff.failure.title'),
                normalizeErrorMessage(result.error),
                {
                    cancelText: t('common.cancel'),
                    confirmText: t('common.retry'),
                },
            );
            if (!shouldRetry) {
                return { ok: false, handled: true };
            }
        } catch (error) {
            const shouldRetry = await Modal.confirm(
                t('sessionHandoff.failure.title'),
                normalizeErrorMessage(error instanceof Error ? error.message : error),
                {
                    cancelText: t('common.cancel'),
                    confirmText: t('common.retry'),
                },
            );
            if (!shouldRetry) {
                return { ok: false, handled: true };
            }
        } finally {
            closeProgressModal();
        }
    }
}
