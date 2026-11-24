import type { RestartSessionRunnerResultV1 } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV1';

import { presentApprovalFailure } from '@/components/tools/shell/approvals/useApprovalDecisionHandler';
import { readRestartResultBodyKey } from '@/components/sessions/sessionRunner/staleSessionRunnerNoticePresentation';
import { resolveActionExecutionErrorMessage, resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { t } from '@/text';
import { alertActionFailure, readSafeFailureDetails, type ActionFailureContext } from '@/utils/errors/alertActionFailure';
import { HappyError } from '@/utils/errors/errors';
import { getErrorMessage } from '@/utils/errors/getErrorMessage';

/**
 * The composer's one alert for a failed Send or runner restart: a readable reason, and the typed code with
 * its safe details only behind the app's Technical details. Never the producer's prose, payloads or secrets.
 */

/** A thrown Send or Action failure; the HappyError keeps the Action's `errorCode` and `details`. */
export function alertComposerError(error: unknown): void {
    const fallback = getErrorMessage(error) || t('errors.failedToSendMessage');
    const message = resolveActionExecutionErrorMessage(error, fallback, { closedCodesOnly: true });
    const { reason, code } = presentApprovalFailure(error, message, t('common.requestFailed'));
    alertActionFailure({
        reason,
        code,
        context: error instanceof HappyError ? readSafeFailureDetails(error.details) : undefined,
    });
}

/** A settled Action or Session submit refusal, with the producer's typed cause. */
export function alertComposerActionResultFailure(result: unknown): void {
    const record = typeof result === 'object' && result !== null ? result as Readonly<Record<string, unknown>> : {};
    const fallback = t('common.requestFailed');
    const message = record.type === 'send_failed' || record.type === 'rejected'
        ? resolveActionExecutionErrorMessage(record, fallback, { closedCodesOnly: true })
        : resolveActionExecutionFailureMessage(result, fallback) ?? fallback;
    const { reason, code } = presentApprovalFailure(record, message, fallback);
    alertActionFailure({
        reason,
        code,
        context: readSafeFailureDetails(record.details),
        requestId: typeof record.requestId === 'string' ? record.requestId : undefined,
    });
}

/** A runner restart the daemon did not complete; its status and reason code are closed vocabularies. */
export function alertComposerRunnerRestartFailure(result: RestartSessionRunnerResultV1): void {
    const context: Record<string, string | number | boolean | null> = { status: result.status };
    if (result.reasonCode) context.reasonCode = result.reasonCode;
    const diagnostics = readSafeFailureDetails(result.diagnostics);
    alertActionFailure({
        reason: t(readRestartResultBodyKey(result) ?? 'session.staleRunner.banner.failedBody'),
        code: result.reasonCode ?? (typeof diagnostics.errorCode === 'string' ? diagnostics.errorCode : result.status),
        context: { ...context, ...diagnostics } satisfies ActionFailureContext,
    });
}

/** The armed route could not read the runner's status, so nothing was restarted. */
export function alertComposerRuntimeStatusUnavailable(): void {
    alertActionFailure({ reason: t('session.staleRunner.banner.unavailableBody'), code: 'runner_status_unavailable' });
}
