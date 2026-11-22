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
        default: return t('browserRecording.failure.startBody');
    }
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
