import { t } from '@/text';
import { areSessionAddressesEqual, type SessionAddress } from '@/sync/domains/session/sessionAddress';

/** Applied audio belongs to the exact viewed Home-qualified Session, not a matching bare id. */
export function readSessionVoiceInUse<T>(inUse: T | null, sessionAddress: SessionAddress,
  attemptTargetSessionAddress: SessionAddress | null): T | null {
  return areSessionAddressesEqual(sessionAddress, attemptTargetSessionAddress) ? inUse : null;
}

/**
 * The Voice row's one line: a pending write, a refused one, then why a saved choice cannot apply, then
 * the voice the running attempt actually applied — with a different saved choice waiting for the next
 * attempt — otherwise the voice it will speak with. It never claims a saved choice is the current
 * audio, and it never repeats the picker's footer (when a choice applies is said there, once).
 */
export function resolveSessionVoiceLine(input: Readonly<{
  saving: boolean;
  /** The last change was refused; the line says so until the next attempt. */
  refused?: boolean;
  unavailable: 'provider_mismatch' | 'voice_missing' | 'override_unsupported' | 'invalid_value' | null;
  providerLabel: string;
  providerId: string;
  inUseProviderId: string | null;
  /** An unrequested/loading catalog is not evidence that a saved voice was removed. */
  catalogLoaded: boolean;
  inUseName: string | null;
  inUseId: string | null;
  desiredId: string | null;
  desiredName: string | null;
  sessionAddress: SessionAddress;
  attemptTargetSessionAddress: SessionAddress | null;
}>): string {
  if (input.saving) return t('sessionVoice.pending');
  if (input.refused) return t('sessionVoice.refused');
  if (input.unavailable === 'provider_mismatch') return t('sessionVoice.providerMismatch', { provider: input.providerLabel });
  if (input.unavailable === 'override_unsupported') return t('sessionVoice.overrideUnsupported', { provider: input.providerLabel });
  if (input.unavailable && (input.unavailable !== 'voice_missing' || input.catalogLoaded)) return t('sessionVoice.unavailablePreference');
  const inUse = readSessionVoiceInUse({ name: input.inUseName, id: input.inUseId },
    input.sessionAddress, input.attemptTargetSessionAddress);
  if (!inUse?.name) {
    return input.desiredName
      ? t('sessionVoice.idleVoice', { voice: input.desiredName })
      : t('sessionVoice.idleAccount');
  }
  if (input.desiredId && inUse.id && (input.desiredId !== inUse.id || input.providerId !== input.inUseProviderId)) {
    return t('sessionVoice.workNextVoice', { next: input.desiredName ?? input.desiredId, voice: inUse.name });
  }
  return t('sessionVoice.workCurrentVoice', { voice: inUse.name });
}
