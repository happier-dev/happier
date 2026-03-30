import type { OperationalMemoryEmbeddingsDiagnostics } from '@/daemon/memory/resolveOperationalMemoryEmbeddingsSettings';

export type EmbeddingsProvider = Readonly<{
  providerKind: 'local_transformers' | 'openai_compatible';
  modelId: string;
  embedQuery: (text: string) => Promise<Float32Array>;
  embedDocuments: (texts: readonly string[]) => Promise<Float32Array[]>;
}>;

export type EmbeddingsProviderResolution = Readonly<{
  provider: EmbeddingsProvider | null;
} & OperationalMemoryEmbeddingsDiagnostics>;
