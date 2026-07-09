import type { VoiceDaemonPcmCaptureAvailability } from '@/voice/settings/resolveVoiceProviderAvailability';

export function resolveDaemonSpeechPcmCaptureAvailability(): VoiceDaemonPcmCaptureAvailability {
    return 'available';
}
