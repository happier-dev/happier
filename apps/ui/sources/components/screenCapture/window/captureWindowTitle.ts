import type { NativeCaptureResult } from '@/desktop/capture/nativeCapture';
import { t } from '@/text';

/**
 * The native title of one Capture window. The panels stay out of the Window menu, Dock and ⌘`, so
 * assistive tech is its reader; it names the same source facts as the window's caption.
 */
export function captureWindowTitle(capture: Pick<NativeCaptureResult, 'kind' | 'source'>): string {
    const facts = [capture.source?.appName, capture.kind === 'still' ? capture.source?.windowTitle : null]
        .filter((fact): fact is string => Boolean(fact));
    const subject = capture.kind === 'video'
        ? [t('screenCapture.recording.title'), ...facts].join(' · ')
        : facts.length > 0 ? facts.join(' · ') : t('screenCapture.window.region');
    return t('screenCapture.window.nativeTitle', { subject });
}
