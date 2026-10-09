import { t } from '@/text';

/**
 * The Voice row's one line: a pending write, then why a saved choice cannot apply, then the voice the
 * running attempt actually applied — with a different saved choice waiting for the next attempt —
 * otherwise when a choice applies. It never claims a saved choice is the current audio.
 */
export function resolveSessionVoiceLine(input: Readonly<{
  saving: boolean;
  unavailable: 'provider_mismatch' | 'voice_missing' | 'override_unsupported' | 'invalid_value' | null;
  providerLabel: string;
  inUseName: string | null;
  inUseId: string | null;
  desiredId: string | null;
  desiredName: string | null;
}>): string {
  if (input.saving) return t('sessionVoice.pending');
  if (input.unavailable === 'provider_mismatch') return t('sessionVoice.providerMismatch', { provider: input.providerLabel });
  if (input.unavailable === 'override_unsupported') return t('sessionVoice.overrideUnsupported', { provider: input.providerLabel });
  if (input.unavailable) return t('sessionVoice.unavailablePreference');
  if (!input.inUseName) return t('sessionVoice.preferenceHint');
  if (input.desiredId && input.inUseId && input.desiredId !== input.inUseId) {
    return t('sessionVoice.workNextVoice', { next: input.desiredName ?? input.desiredId, voice: input.inUseName });
  }
  return t('sessionVoice.workCurrentVoice', { voice: input.inUseName });
}
