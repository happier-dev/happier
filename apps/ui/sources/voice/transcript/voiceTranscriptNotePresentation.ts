import { t } from '@/text';
import { getDeviceAnalyticsId } from '@/track/settingsAnalytics/deviceAnalyticsIdentity';
import { readVoiceContinuationProvenance, type VoiceContinuationProvenance } from './voiceTranscriptNoteMeta';

/** Local presentation only: the synced note carries provenance, not the author's viewpoint or locale. */
export function resolveVoiceContinuationNoteText(meta: unknown, viewerDeviceId?: string | null): string | null {
    const continuation = readVoiceContinuationProvenance(meta);
    return continuation ? presentVoiceContinuation(continuation, viewerDeviceId) : null;
}

/** The same viewer-relative words for a continuation fact already read (an ended attempt's reason). */
export function presentVoiceContinuation(continuation: VoiceContinuationProvenance, viewerDeviceId?: string | null): string {
    const viewer = viewerDeviceId === undefined ? getDeviceAnalyticsId() : viewerDeviceId;
    if (viewer && continuation.deviceId === viewer) return t('voiceMoments.continuedHere');
    return continuation.deviceDisplayName
        ? t('voiceMoments.continuedOn', { device: continuation.deviceDisplayName })
        : t('voiceMoments.continuedElsewhere');
}
