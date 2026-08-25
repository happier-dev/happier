import type { VoiceReadinessFact } from '@/voice/registry/readiness';

/**
 * Web never executes Local Neural STT on-device. The native implementation
 * reads the selected pack's installer-owned state instead.
 */
export async function readVoiceDictationNativeModelReadiness(
  _packId: string | null,
): Promise<VoiceReadinessFact> {
  return 'unknown';
}
