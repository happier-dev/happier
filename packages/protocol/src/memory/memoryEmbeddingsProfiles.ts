import type {
  MemoryEmbeddingsBlend,
  MemoryEmbeddingsLocalTransformersConfig,
  MemoryEmbeddingsPresetId,
} from './memorySettings.js';

export type MemoryEmbeddingsProfileMetadata = Readonly<{
  id: MemoryEmbeddingsPresetId;
  label: string;
  description: string;
  providerKind: MemoryEmbeddingsLocalTransformersConfig['kind'];
  expectedDimensions: number | null;
  useCase: 'balanced' | 'long_context' | 'quality';
  queryPrefix: string | null;
  documentPrefix: string | null;
  blend: MemoryEmbeddingsBlend;
  config: MemoryEmbeddingsLocalTransformersConfig;
}>;

const DEFAULT_BLEND: MemoryEmbeddingsBlend = {
  ftsWeight: 0.7,
  embeddingWeight: 0.3,
};

export const MEMORY_EMBEDDINGS_PROFILE_REGISTRY: Record<MemoryEmbeddingsPresetId, MemoryEmbeddingsProfileMetadata> = {
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    description: 'Fastest validated local model with good general retrieval quality.',
    providerKind: 'local_transformers',
    expectedDimensions: 384,
    useCase: 'balanced',
    queryPrefix: null,
    documentPrefix: null,
    blend: DEFAULT_BLEND,
    config: {
      kind: 'local_transformers',
      modelId: 'Xenova/all-MiniLM-L6-v2',
      queryPrefix: null,
      documentPrefix: null,
    },
  },
  long_context: {
    id: 'long_context',
    label: 'Long context',
    description: 'Better fit for longer conversation chunks and broad recall queries.',
    providerKind: 'local_transformers',
    expectedDimensions: 512,
    useCase: 'long_context',
    queryPrefix: null,
    documentPrefix: null,
    blend: DEFAULT_BLEND,
    config: {
      kind: 'local_transformers',
      modelId: 'Xenova/jina-embeddings-v2-small-en',
      queryPrefix: null,
      documentPrefix: null,
    },
  },
  quality: {
    id: 'quality',
    label: 'Quality',
    description: 'Higher-cost preset kept configurable for QA and manual evaluation.',
    providerKind: 'local_transformers',
    expectedDimensions: 768,
    useCase: 'quality',
    queryPrefix: null,
    documentPrefix: null,
    blend: DEFAULT_BLEND,
    config: {
      kind: 'local_transformers',
      modelId: 'Alibaba-NLP/gte-modernbert-base',
      queryPrefix: null,
      documentPrefix: null,
    },
  },
};

export function getMemoryEmbeddingsProfileMetadata(
  profileId: MemoryEmbeddingsPresetId,
): MemoryEmbeddingsProfileMetadata {
  return MEMORY_EMBEDDINGS_PROFILE_REGISTRY[profileId] ?? MEMORY_EMBEDDINGS_PROFILE_REGISTRY.balanced;
}
