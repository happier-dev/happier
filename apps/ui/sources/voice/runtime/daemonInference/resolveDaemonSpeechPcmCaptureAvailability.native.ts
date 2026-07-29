import { getSharedVoicePcmCapture } from '@happier-dev/audio-stream-native';

import type { VoiceDaemonPcmCaptureAvailability } from '@/voice/settings/resolveVoiceProviderAvailability';

export function resolveDaemonSpeechPcmCaptureAvailability(): VoiceDaemonPcmCaptureAvailability {
    try {
        return getSharedVoicePcmCapture() ? 'available' : 'unavailable';
    } catch {
        return 'unavailable';
    }
}
