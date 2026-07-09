import {
  KOKORO_DEFAULT_TTS_PACK_ID,
  listModelPackCatalogEntries,
  resolveCanonicalModelPackId,
} from '@happier-dev/protocol';
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

// Display copy is host-local; resolvable ids are sourced from the protocol
// model-pack catalog so settings never persist legacy browser `-wasm` ids.
const BUILT_IN_ASSET_SET_COPY: Readonly<Record<string, Pick<KokoroAssetSetOption, 'title' | 'subtitle'>>> = {
  [KOKORO_DEFAULT_TTS_PACK_ID]: {
    title: 'Kokoro 82M',
    subtitle: 'Default local neural voice model.',
  },
  'kokoro-en-v0_19': {
    title: 'Kokoro v0.19',
    subtitle: 'Higher-quality local Kokoro voice model.',
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
    .filter((entry) => entry.model.toLowerCase().includes('kokoro') || entry.packId.toLowerCase().includes('kokoro'))
    .map((entry) => ({
      id: entry.packId,
      title: BUILT_IN_ASSET_SET_COPY[entry.packId]?.title ?? deriveDisplayTitle(entry.model || entry.packId),
      subtitle: BUILT_IN_ASSET_SET_COPY[entry.packId]?.subtitle,
    }));
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
    if (!id || normalized.has(id)) {
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
      title: 'Default (from env)',
      subtitle: 'Uses environment-configured Kokoro model-pack defaults.',
    },
    ...concrete,
  ];
}
