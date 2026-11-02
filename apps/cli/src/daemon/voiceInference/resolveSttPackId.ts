import { getModelPackCatalogEntry, listModelPackCatalogEntries } from '@happier-dev/protocol/voice/modelPacks/catalog';

import { createVoiceInferenceError, normalizePackId } from './voiceInferenceWorker.shared';

/** Resolve once at STT admission; installation and loading remain lifecycle-owned. */
export function resolveSttPackId(packId: string | null, language: string | null, streaming: boolean): string {
  const selectedPackId = normalizePackId(packId);
  if (!selectedPackId) throw createVoiceInferenceError('model_not_installed');
  const selected = getModelPackCatalogEntry(selectedPackId);
  const requestedLanguage = language?.trim().toLowerCase().split(/[-_]/)[0];
  // Public plugin packs own their runtime descriptors; the built-in catalog
  // cannot supply or infer language facts for those independent contributions.
  if (!requestedLanguage || !selected) return selectedPackId;

  const matches = (entry: NonNullable<typeof selected>) => entry.kind === 'stt_sherpa'
    && (!streaming || entry.streamingCapable)
    && entry.languages?.some(code => code.toLowerCase() === requestedLanguage) === true;
  if (matches(selected)) return selectedPackId;
  const matching = listModelPackCatalogEntries('stt_sherpa')
    .find(entry => entry.publicationStatus === 'published' && matches(entry));
  if (!matching) throw createVoiceInferenceError('runtime_unavailable', 'voice_inference_stt_language_unavailable');
  return matching.packId;
}
