import { ActionFailureCauseV1Schema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readActionFailureEnvelope } from '@happier-dev/protocol/actions/executor/actionFailureEnvelope';
import { presentActionExecutionFailure } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import { alertActionFailure } from '@/utils/errors/alertActionFailure';
import { RecordingSaveFailureV1Schema } from '@happier-dev/protocol/recording/results';
import { BrowserRecordingOutcomeReasonV1Schema } from '@happier-dev/protocol/browser/recording/v1';
import { Modal } from '@/modal';
import { t } from '@/text';

/**
 * Why a Machine could not start a recording, for Browser and Computer alike. A refusal the person cannot
 * wait out (turned off, not allowed, no encoder) says so instead of "try again"; anything unnamed keeps the
 * generic sentence. The daemon's diagnostic message is never shown.
 */
export function presentRecordingStartRefusal(reasonCode: string): void {
    Modal.alert(t('browserRecording.failure.startTitle'), describeRecordingStartRefusal(reasonCode));
}

function describeRecordingStartRefusal(reasonCode: string): string {
    switch (reasonCode) {
        case 'browser_recording_disabled': return t('browserRecording.status.turnedOff');
        case 'browser_recording_policy_denied': return t('browserRecording.status.notAllowed');
        case 'encoder_unavailable': return t('browserRecording.failure.encoderUnavailable');
        case 'encoder_failed': return t('browserRecording.failure.encoderFailed');
        case 'recording_session_not_owned': return t('browserRecording.failure.sessionNotOwned');
        case 'recording_session_unavailable': return t('browserRecording.failure.sessionUnavailable');
        default: return t('browserRecording.failure.startBody');
    }
}

/**
 * What a Stop answered, for Browser and Computer alike (the shared recording result shape). A saved recording
 * says nothing. A `failed` stop ended the capture, so it says the recording stopped and what became of it;
 * only a stop with no answer keeps "it may still be recording".
 */
export function presentRecordingStopOutcome(answer: unknown): void {
    const status = answer && typeof answer === 'object' ? (answer as { status?: unknown }).status : undefined;
    if (status === 'finalized') return;
    if (status !== 'failed') {
        presentBrowserRecordingActionFailure('stop');
        return;
    }
    const saveFailure = RecordingSaveFailureV1Schema.safeParse((answer as { saveFailure?: unknown }).saveFailure).data;
    const reason = BrowserRecordingOutcomeReasonV1Schema.safeParse((answer as { reason?: unknown }).reason).data;
    const code = saveFailure ?? reason ?? 'action_failed';
    // A recording kept in the Session's files was saved; only its place in the conversation is missing.
    alertActionFailure({
        title: t(saveFailure === 'transcript_attach_failed' ? 'browserRecording.failure.notInConversationTitle'
        : 'browserRecording.failure.notSavedTitle'), reason: saveFailure === 'workspace_write_failed'
        ? t('browserRecording.failure.notSavedGone')
        : saveFailure === 'transcript_attach_failed'
            ? t('browserRecording.failure.notSavedInFiles')
            : t('browserRecording.failure.notSavedBody'),
        code,
        failureCause: ActionFailureCauseV1Schema.safeParse((answer as { failureCause?: unknown }).failureCause).data,
        requestId: typeof (answer as { requestId?: unknown }).requestId === 'string'
            ? (answer as { requestId: string }).requestId : undefined,
        // Each fact once: the title already says it failed, and a reason that is the code is not a second fact.
        ...(reason && reason !== code ? { context: { reason } } : {}),
    });
}

export function presentBrowserRecordingActionFailure(action: 'start' | 'stop' | 'discard', outcome?: unknown): void {
    const title = t(action === 'start' ? 'browserRecording.failure.startTitle'
        : action === 'stop' ? 'browserRecording.failure.stopTitle' : 'browserRecording.failure.discardTitle');
    const refusal = readActionFailureEnvelope(outcome);
    const fallback = action === 'start' ? describeRecordingStartRefusal(refusal?.errorCode ?? '')
        : t(action === 'stop' ? 'browserRecording.failure.stopBody' : 'browserRecording.failure.discardBody');
    if (!refusal) {
        Modal.alert(title, fallback);
        return;
    }
    const presentation = presentActionExecutionFailure(refusal, fallback, { closedCodesOnly: true });
    alertActionFailure({ title, reason: presentation.reason, code: refusal.errorCode, requestId: refusal.requestId,
        context: Object.fromEntries(presentation.technicalDetails.filter(line => line.key !== 'code').map(line => [line.key, line.value])) });
}
