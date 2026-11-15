import { Modal } from '@/modal';
import { t } from '@/text';

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
