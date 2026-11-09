import { Modal } from '@/modal';
import { t } from '@/text';

function sanitizeMessageLocalIdSegment(value: string): string {
    const sanitized = value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '');
    return sanitized.length > 0 ? sanitized.slice(0, 80) : 'view';
}

/** The Session message a finished recording lands in; Browser and Computer share the recorder's media target. */
export function buildRecordingMessageLocalId(viewId: string, atMs: number): string {
    return `browser-recording-${sanitizeMessageLocalIdSegment(viewId)}-${atMs}`;
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
