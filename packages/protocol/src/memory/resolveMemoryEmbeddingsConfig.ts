import { getMemoryEmbeddingsProfileMetadata, type MemoryEmbeddingsProfileMetadata } from './memoryEmbeddingsProfiles.js';
import type { MemoryEmbeddingsBlend, MemoryEmbeddingsCustomConfig, MemoryEmbeddingsSettingsV2 } from './memorySettings.js';

export type ResolvedMemoryEmbeddingsConfig = Readonly<{
  enabled: boolean;
  mode: MemoryEmbeddingsSettingsV2['mode'];
  profile: MemoryEmbeddingsProfileMetadata | null;
  provider: MemoryEmbeddingsCustomConfig | null;
  blend: MemoryEmbeddingsBlend;
}>;

const DEFAULT_BLEND: MemoryEmbeddingsBlend = {
  ftsWeight: 0.7,
  embeddingWeight: 0.3,
};

function normalizeBlend(blend: MemoryEmbeddingsSettingsV2['blend'] | null | undefined): MemoryEmbeddingsBlend {
  return {
    ftsWeight: typeof blend?.ftsWeight === 'number' ? blend.ftsWeight : DEFAULT_BLEND.ftsWeight,
    embeddingWeight: typeof blend?.embeddingWeight === 'number' ? blend.embeddingWeight : DEFAULT_BLEND.embeddingWeight,
  };
}

export function resolveMemoryEmbeddingsConfig(
  settings: Pick<MemoryEmbeddingsSettingsV2, 'mode' | 'presetId' | 'custom' | 'blend'>,
): ResolvedMemoryEmbeddingsConfig {
  const blend = normalizeBlend(settings.blend);
  if (settings.mode === 'disabled') {
    return {
      enabled: false,
      mode: 'disabled',
      profile: null,
      provider: null,
      blend,
    };
  }

  if (settings.mode === 'preset') {
    const profile = getMemoryEmbeddingsProfileMetadata(settings.presetId);
    return {
      enabled: true,
      mode: 'preset',
      profile,
      provider: profile.config,
      blend,
    };
  }

  return {
    enabled: true,
    mode: 'custom',
    profile: null,
    provider: settings.custom ?? null,
    blend,
  };
}
