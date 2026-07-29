import {
    SessionHandoffPrepareTargetResumeResponseSchema,
    type ActionExecuteResult,
    type ActionExecutorContext,
    type SessionHandoffWorkspaceTransfer,
} from '@happier-dev/protocol';

import { Modal } from '@/modal';
import { t } from '@/text';
import { openSessionHandoffProgressModal } from '@/components/sessions/handoff/openSessionHandoffProgressModal';
import { openSessionHandoffFailureRecoveryModal } from '@/components/sessions/handoff/openSessionHandoffFailureRecoveryModal';

import { executeSessionHandoffAction } from './executeSessionHandoffAction';
import { subscribeSessionHandoffProgress } from './sessionHandoffProgressEvents';
import { performSessionHandoffRecoveryAction } from '../../ops/sessionHandoffs';
import { randomUUID } from '@/platform/randomUUID';

type ExecuteAction = (
    actionId: 'session.handoff' | 'session.handoff.prepare_target.resume',
    input: unknown,
    context?: ActionExecutorContext,
) => Promise<ActionExecuteResult>;

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
        let activeResumeHandler: Readonly<{
            key: string;
            run: () => Promise<void>;
            shouldOffer: () => boolean;
        }> | null = null;
        const unsubscribeProgress = subscribeSessionHandoffProgress((update) => {
            if (update.sessionId !== args.sessionId || update.targetMachineId !== args.targetMachineId) {
                return;
            }
            const jobId = update.status.jobId;
            const transitionRevision = update.transitionRevision;
            const canResume = update.status.status === 'awaiting_user_resume'
                && typeof jobId === 'string'
                && jobId.length > 0
                && typeof transitionRevision === 'number'
                && Number.isSafeInteger(transitionRevision)
                && transitionRevision >= 0;
            let onResume: (() => Promise<void>) | undefined;
            if (canResume) {
                const key = `${update.status.handoffId}\u0000${jobId}\u0000${transitionRevision}`;
                if (activeResumeHandler?.key !== key) {
                    let request: Promise<void> | null = null;
                    let attemptId: string | null = null;
                    let accepted = false;
                    activeResumeHandler = {
                        key,
                        run: () => {
                            if (request) return request;
                            attemptId ??= randomUUID();
                            request = (async () => {
                                const actionResult = await args.execute(
                                    'session.handoff.prepare_target.resume',
                                    {
                                        handoffId: update.status.handoffId,
                                        jobId,
                                        expectedRevision: transitionRevision,
                                        attemptId,
                                    },
                                    args.context,
                                );
                                if (!actionResult.ok) {
                                    await Modal.alert(
                                        t('sessionHandoff.failure.title'),
                                        normalizeErrorMessage(actionResult.error),
                                    );
                                    return;
                                }
                                const parsed = SessionHandoffPrepareTargetResumeResponseSchema.safeParse(
                                    actionResult.result,
                                );
                                if (!parsed.success) {
                                    await Modal.alert(
                                        t('sessionHandoff.failure.title'),
                                        t('errors.unknownError'),
                                    );
                                    return;
                                }
                                if (!parsed.data.ok) {
                                    await Modal.alert(
                                        t('sessionHandoff.failure.title'),
                                        parsed.data.error.message,
                                    );
                                    return;
                                }
                                accepted = true;
                                Modal.update(modalId, {
                                    status: parsed.data.status,
                                    onResume: undefined,
                                });
                            })().finally(() => {
                                request = null;
                            });
                            return request;
                        },
                        shouldOffer: () => !accepted,
                    };
                }
                onResume = activeResumeHandler.shouldOffer()
                    ? activeResumeHandler.run
                    : undefined;
            } else {
                activeResumeHandler = null;
            }
            Modal.update(modalId, {
                status: update.status,
                onResume,
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
                const recovery = result.recovery as any;
                let recoveryError: unknown = result.error;
                while (true) {
                    const recoveryPresentation = buildSessionHandoffRecoveryPresentation(recoveryError);
                    const action = await openSessionHandoffFailureRecoveryModal({
                        title: recoveryPresentation.title,
                        message: recoveryPresentation.message,
                        details: recoveryPresentation.details,
                        recovery,
                    });
                    if (!action) {
                        return { ok: false, handled: true };
                    }
                    try {
                        const recoveryResult = await performSessionHandoffRecoveryAction({
                            recovery,
                            action,
                        });
                        if (recoveryResult.ok) {
                            return { ok: false, handled: true };
                        }
                        recoveryError = normalizeErrorMessage(recoveryResult.error);
                    } catch (error) {
                        recoveryError = normalizeErrorMessage(
                            error instanceof Error ? error.message : error,
                        );
                    }
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
