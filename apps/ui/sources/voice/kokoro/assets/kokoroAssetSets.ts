import {
  KOKORO_DEFAULT_TTS_PACK_ID,
  getModelPackCatalogEntry,
  isPublishedModelPackCatalogEntry,
  listModelPackCatalogEntries,
  resolveCanonicalModelPackId,
} from '@happier-dev/protocol';
import { t } from '@/text';
import { z } from 'zod';

const EXPO_PUBLIC_KOKORO_ASSET_SETS_ENV_VAR = 'EXPO_PUBLIC_KOKORO_ASSET_SETS';

export type KokoroAssetSetOption = {
  id: string;
  title: string;
  subtitle?: string;
};

const KokoroAssetSetOptionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  subtitle: z.string().optional(),
});

// Display copy is host-local; resolvable ids, including the published q8
// `-wasm` pack identity, are sourced from the protocol model-pack catalog.
const BUILT_IN_ASSET_SET_COPY: Readonly<Record<string, Readonly<{
  title: string;
  subtitleKey:
    | 'settingsVoice.local.models.nativeOptions.kokoroDefaultSubtitle'
    | 'settingsVoice.local.models.nativeOptions.kokoroHigherQualitySubtitle';
}>>> = {
  [KOKORO_DEFAULT_TTS_PACK_ID]: {
    title: 'Kokoro 82M',
    subtitleKey: 'settingsVoice.local.models.nativeOptions.kokoroDefaultSubtitle',
  },
  'kokoro-en-v0_19': {
    title: 'Kokoro v0.19',
    subtitleKey: 'settingsVoice.local.models.nativeOptions.kokoroHigherQualitySubtitle',
  },
};

function deriveDisplayTitle(model: string): string {
  return model
    .replace(/^kokoro-/i, 'Kokoro ')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getBuiltInAssetSets(): KokoroAssetSetOption[] {
  return listModelPackCatalogEntries('tts_sherpa')
    .filter(isPublishedModelPackCatalogEntry)
    .filter((entry) => entry.model.toLowerCase().includes('kokoro') || entry.packId.toLowerCase().includes('kokoro'))
    .map((entry) => {
      const copy = BUILT_IN_ASSET_SET_COPY[entry.packId];
      return {
        id: entry.packId,
        title: copy?.title ?? deriveDisplayTitle(entry.model || entry.packId),
        subtitle: copy ? t(copy.subtitleKey) : undefined,
      };
    });
}

function readAssetSetsFromEnv(env: Record<string, string | undefined>): KokoroAssetSetOption[] | null {
  const raw = env[EXPO_PUBLIC_KOKORO_ASSET_SETS_ENV_VAR];
  if (!raw || !raw.trim()) return null;
  try {
    const parsed = KokoroAssetSetOptionSchema.array().safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function normalizeConcreteOptions(options: readonly KokoroAssetSetOption[]): KokoroAssetSetOption[] {
  const normalized = new Map<string, KokoroAssetSetOption>();
  for (const option of options) {
    const id = resolveCanonicalModelPackId(option.id);
    const catalogEntry = getModelPackCatalogEntry(id);
    if (
      !id
      || normalized.has(id)
      || (catalogEntry !== null && !isPublishedModelPackCatalogEntry(catalogEntry))
    ) {
      continue;
    }
    normalized.set(id, { ...option, id });
  }
  return [...normalized.values()];
}

export function getKokoroAssetSetOptions(env: Record<string, string | undefined> = process.env): KokoroAssetSetOption[] {
  const fromEnv = readAssetSetsFromEnv(env);
  const concrete = normalizeConcreteOptions(fromEnv && fromEnv.length > 0 ? fromEnv : getBuiltInAssetSets());
  return [
    {
      id: '',
      title: t('settingsVoice.local.models.nativeOptions.kokoroEnvironmentDefaultTitle'),
      subtitle: t('settingsVoice.local.models.nativeOptions.kokoroEnvironmentDefaultSubtitle'),
    },
    ...concrete,
  ];
}
