/**
 * Voice ids are stored in one synced setting shared by every device, but web (kokoro-js) and
 * native (Sherpa model packs) ship different voice catalogs. Each platform resolves the stored id
 * against its own catalog at speak time and falls back to its own default.
 */

export { KOKORO_WEB_DEFAULT_VOICE_ID, resolveKokoroWebVoiceId } from '../../../../public/vendor/kokoro/resolveKokoroVoice.js';

type ManifestVoiceCatalog = Readonly<{
  voices?: ReadonlyArray<Readonly<{ id: string; sid?: number }>> | null;
  defaultVoiceId?: string | null;
}>;

export type ResolvedKokoroNativeVoice = Readonly<{ voiceId: string; sid: number }>;

/**
 * Resolves the voice for an installed native model pack that publishes a voice catalog. Returns
 * null only when the manifest has no usable catalog (legacy packs), in which case the caller uses
 * the built-in sherpa speaker mapping.
 */
export function resolveKokoroNativeVoice(
  manifest: ManifestVoiceCatalog | null | undefined,
  voiceId: string | null | undefined,
): ResolvedKokoroNativeVoice | null {
  const catalog = (manifest?.voices ?? []).filter(
    (voice): voice is Readonly<{ id: string; sid: number }> => typeof voice?.sid === 'number',
  );
  if (catalog.length === 0) return null;

  const requested = typeof voiceId === 'string' ? voiceId.trim() : '';
  const match =
    catalog.find((voice) => voice.id === requested)
    ?? catalog.find((voice) => voice.id === manifest?.defaultVoiceId)
    ?? catalog[0]!;
  return { voiceId: match.id, sid: match.sid };
}
