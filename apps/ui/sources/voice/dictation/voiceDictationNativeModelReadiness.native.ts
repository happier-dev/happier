import type { VoiceReadinessFact } from '@/voice/registry/readiness';
import { getModelPackInstallSummary } from '@/voice/modelPacks/installer.native';

/**
 * Passive native model readiness for the exact Dictation-selected pack. The
 * installer owns filesystem reconciliation and installed-pack validity.
 */
export async function readVoiceDictationNativeModelReadiness(
  packId: string | null,
): Promise<VoiceReadinessFact> {
  if (!packId) return 'unknown';

  try {
    const summary = await getModelPackInstallSummary({ packId });
    return summary.installed ? 'ready' : 'missing';
  } catch {
    return 'unknown';
  }
}
