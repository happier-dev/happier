import type {
  DaemonVoiceInferenceModelStatus,
  ModelPackVoiceCatalogEntry,
} from '@happier-dev/protocol';
import { resolveCanonicalModelPackId } from '@happier-dev/protocol';

export type DaemonTtsVoiceSelection = Readonly<{
  voices: readonly ModelPackVoiceCatalogEntry[];
  selectedVoiceId: string | null;
}>;

/**
 * Resolves the voice picker from the selected daemon pack's projected status.
 * A stored selection that disappeared is deliberately not replaced by the
 * default: the user must choose a currently declared voice before another
 * request can be admitted with that stale intent.
 */
export function resolveDaemonTtsVoiceSelection(input: Readonly<{
  packId: string;
  configuredVoiceId: string | null | undefined;
  statuses: readonly DaemonVoiceInferenceModelStatus[];
}>): DaemonTtsVoiceSelection {
  const canonicalPackId = resolveCanonicalModelPackId(input.packId);
  const status = input.statuses.find((candidate) => (
    candidate.kind === 'tts_sherpa'
    && resolveCanonicalModelPackId(candidate.packId) === canonicalPackId
  ));
  const voices = status?.voices ?? [];
  const configuredVoiceId = typeof input.configuredVoiceId === 'string'
    && input.configuredVoiceId.trim().length > 0
    ? input.configuredVoiceId.trim()
    : null;

  if (configuredVoiceId !== null) {
    return {
      voices,
      selectedVoiceId: voices.some((voice) => voice.id === configuredVoiceId)
        ? configuredVoiceId
        : null,
    };
  }

  const declaredDefault = status?.defaultVoiceId ?? null;
  return {
    voices,
    selectedVoiceId: declaredDefault !== null
      && voices.some((voice) => voice.id === declaredDefault)
      ? declaredDefault
      : null,
  };
}
