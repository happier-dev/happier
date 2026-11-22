import { RecordingSaveFailureV1Schema } from '@happier-dev/protocol/recording/results';
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
    // A recording kept in the Session's files was saved; only its place in the conversation is missing.
    Modal.alert(t(saveFailure === 'transcript_attach_failed' ? 'browserRecording.failure.notInConversationTitle'
        : 'browserRecording.failure.notSavedTitle'), saveFailure === 'workspace_write_failed'
        ? t('browserRecording.failure.notSavedGone')
        : saveFailure === 'transcript_attach_failed'
            ? t('browserRecording.failure.notSavedInFiles')
            : t('browserRecording.failure.notSavedBody'));
}

export function presentBrowserRecordingActionFailure(action: 'start' | 'stop' | 'discard'): void {
    if (action === 'start') {
        Modal.alert(t('browserRecording.failure.startTitle'), t('browserRecording.failure.startBody'));
        return;
    }
    if (action === 'stop') {
        Modal.alert(t('browserRecording.failure.stopTitle'), t('browserRecording.failure.stopBody'));
        return;
    }
    Modal.alert(t('browserRecording.failure.discardTitle'), t('browserRecording.failure.discardBody'));
}
