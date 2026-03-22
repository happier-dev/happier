import type { ActionExecutorContext, SessionHandoffWorkspaceTransfer } from '@happier-dev/protocol';

import { Modal } from '@/modal';
import { t } from '@/text';
import { openSessionHandoffProgressModal } from '@/components/sessions/handoff/openSessionHandoffProgressModal';
import { openSessionHandoffFailureRecoveryModal } from '@/components/sessions/handoff/openSessionHandoffFailureRecoveryModal';

import { executeSessionHandoffAction } from './executeSessionHandoffAction';
import { subscribeSessionHandoffProgress } from './sessionHandoffProgressEvents';
import { performSessionHandoffRecoveryAction } from '../../ops/sessionHandoffs';

type ExecuteAction = (actionId: 'session.handoff', input: unknown, context?: ActionExecutorContext) => Promise<unknown>;

export type RunSessionHandoffUiFlowArgs = Readonly<{
    execute: ExecuteAction;
    sessionId: string;
    targetMachineId: string;
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

function buildSessionHandoffRecoveryPresentation(error: unknown): Readonly<{
    title: string;
    message: string;
    details: string;
}> {
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
        const modalId = openSessionHandoffProgressModal();
        const unsubscribeProgress = subscribeSessionHandoffProgress((update) => {
            if (update.sessionId !== args.sessionId || update.targetMachineId !== args.targetMachineId) {
                return;
            }
            Modal.update(modalId, {
                status: update.status,
            });
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
            let result = await executeSessionHandoffAction(args as any);
            if (result.ok) {
                return result;
            }
            if (result.recovery) {
                closeProgressModal();
                const recoveryPresentation = buildSessionHandoffRecoveryPresentation(result.error);
                const action = await openSessionHandoffFailureRecoveryModal({
                    title: recoveryPresentation.title,
                    message: recoveryPresentation.message,
                    details: recoveryPresentation.details,
                    recovery: result.recovery as any,
                });
                if (!action) {
                    return { ok: false, handled: true };
                }
                const recoveryResult = await performSessionHandoffRecoveryAction({
                    recovery: result.recovery as any,
                    action,
                });
                if (recoveryResult.ok) {
                    return { ok: false, handled: true };
                }
                result = {
                    ...result,
                    error: normalizeErrorMessage(recoveryResult.error),
                };
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
