import { getDefaultModelPackId, listModelPackCatalogEntries } from '@happier-dev/protocol/voice/modelPacks/catalog';
import { formatModelPackDisplayName } from '@/voice/modelPacks/formatDisplayName';
import { t } from '@/text';
import { z } from 'zod/mini';

export type SherpaStreamingSttPackOption = {
  id: string;
  title: string;
  subtitle?: string;
};

const EXPO_PUBLIC_SHERPA_STREAMING_STT_PACKS = 'EXPO_PUBLIC_SHERPA_STREAMING_STT_PACKS';

const SherpaStreamingSttPackOptionSchema = z.object({
  id: z.string().check(z.minLength(1)),
  title: z.string().check(z.minLength(1)),
  subtitle: z.optional(z.string()),
});

function getBuiltInOptions(streamingOnly: boolean): SherpaStreamingSttPackOption[] {
  const defaultPackId = getDefaultModelPackId('stt_sherpa', streamingOnly ? 'streaming' : 'batch');
  return listModelPackCatalogEntries('stt_sherpa')
    .filter(entry => entry.publicationStatus === 'published'
      && (!streamingOnly || (entry.streamingCapable && entry.runtimeFamily === 'sherpa_zipformer_streaming')))
    .sort((a, b) => Number(b.packId === defaultPackId) - Number(a.packId === defaultPackId))
    .map(entry => ({
      id: entry.packId,
      title: formatModelPackDisplayName(entry),
      ...(entry.packId === defaultPackId && streamingOnly
        ? { subtitle: t('settingsVoice.local.models.nativeOptions.sherpaStreamingRecommendedSubtitle') }
        : {}),
    }));
}

function readOptionsFromEnv(env: Record<string, string | undefined>): SherpaStreamingSttPackOption[] | null {
  const raw = env[EXPO_PUBLIC_SHERPA_STREAMING_STT_PACKS];
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = z.array(SherpaStreamingSttPackOptionSchema).safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function getSherpaStreamingSttPackOptions(env: Record<string, string | undefined> = process.env): SherpaStreamingSttPackOption[] {
  return getSherpaSttPackOptions({ streamingOnly: true }, env);
}

export function getSherpaSttPackOptions(
  options: { streamingOnly: boolean },
  env: Record<string, string | undefined> = process.env,
): SherpaStreamingSttPackOption[] {
  const fromEnv = readOptionsFromEnv(env);
  return options.streamingOnly && fromEnv && fromEnv.length > 0 ? fromEnv : getBuiltInOptions(options.streamingOnly);
}
