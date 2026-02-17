import type { MemoryEmbeddingsSettingsV1 } from '@happier-dev/protocol';

export type EmbeddingsProvider = Readonly<{
  provider: string;
  modelId: string;
  embedQuery: (text: string) => Promise<Float32Array>;
  embedDocuments: (texts: readonly string[]) => Promise<Float32Array[]>;
}>;

type FeatureExtractionTensorLike = {
  tolist?: () => any;
  data?: unknown;
  dims?: unknown;
};

function normalizeId(raw: unknown): string {
  return String(raw ?? '').trim();
}

function toFloat32ArrayRow(value: unknown): Float32Array | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const out = new Float32Array(value.length);
  for (let i = 0; i < value.length; i += 1) {
    const n = Number(value[i]);
    out[i] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

function splitBatchFromFlat(data: Float32Array, batch: number, dims: number): Float32Array[] {
  const out: Float32Array[] = [];
  for (let i = 0; i < batch; i += 1) {
    const start = i * dims;
    const end = start + dims;
    out.push(new Float32Array(data.slice(start, end)));
  }
  return out;
}

async function tensorToVectors(tensor: FeatureExtractionTensorLike, expectedBatch: number): Promise<Float32Array[]> {
  const tolist = typeof tensor?.tolist === 'function' ? tensor.tolist : null;
  if (tolist) {
    const list = await tolist();
    if (Array.isArray(list) && expectedBatch === 1 && Array.isArray(list[0])) {
      const row = toFloat32ArrayRow(list[0]);
      return row ? [row] : [];
    }
    if (Array.isArray(list) && expectedBatch > 1 && Array.isArray(list[0])) {
      const rows: Float32Array[] = [];
      for (const rowValue of list) {
        const row = toFloat32ArrayRow(rowValue);
        if (row) rows.push(row);
      }
      return rows;
    }
  }

  const dimsRaw = tensor?.dims;
  const dims = Array.isArray(dimsRaw) ? dimsRaw.map((v) => Number(v)) : null;
  const dataRaw = tensor?.data;
  const data = dataRaw instanceof Float32Array ? dataRaw : null;
  if (!dims || dims.length < 2 || !data) return [];

  const batch = Number.isFinite(dims[0] as number) ? Math.trunc(dims[0] as number) : 0;
  const width = Number.isFinite(dims[1] as number) ? Math.trunc(dims[1] as number) : 0;
  if (batch <= 0 || width <= 0) return [];
  if (batch !== expectedBatch) return [];
  if (data.length !== batch * width) return [];
  return splitBatchFromFlat(data, batch, width);
}

const providerCache = new Map<string, Promise<EmbeddingsProvider | null>>();

export async function resolveEmbeddingsProvider(params: Readonly<{
  settings: MemoryEmbeddingsSettingsV1;
  cacheDir: string;
}>): Promise<EmbeddingsProvider | null> {
  if (params.settings.enabled !== true) return null;
  const provider = normalizeId(params.settings.provider);
  const modelId = normalizeId(params.settings.modelId);
  if (!provider || !modelId) return null;

  const cacheKey = `${provider}::${modelId}::${normalizeId(params.cacheDir)}`;
  const cached = providerCache.get(cacheKey);
  if (cached) return await cached;

  const promise = (async (): Promise<EmbeddingsProvider | null> => {
    if (provider === 'local_transformers') {
      // Lazy import: only used when embeddings are enabled.
      const mod: any = await import('@huggingface/transformers');
      const pipeline: any = mod?.pipeline;
      const env: any = mod?.env;
      if (env && typeof params.cacheDir === 'string' && params.cacheDir.trim()) {
        env.cacheDir = params.cacheDir;
      }
      if (typeof pipeline !== 'function') {
        throw new Error('transformers pipeline is unavailable');
      }

      const extractor = await pipeline('feature-extraction', modelId);

      const embedDocuments = async (texts: readonly string[]): Promise<Float32Array[]> => {
        const clean = texts.map((t) => String(t ?? '').trim());
        if (clean.length === 0) return [];
        const out = await extractor(clean, { pooling: 'mean', normalize: true });
        return await tensorToVectors(out as FeatureExtractionTensorLike, clean.length);
      };

      const embedQuery = async (text: string): Promise<Float32Array> => {
        const clean = String(text ?? '').trim();
        const out = await extractor(clean, { pooling: 'mean', normalize: true });
        const rows = await tensorToVectors(out as FeatureExtractionTensorLike, 1);
        if (!rows[0]) throw new Error('No embedding produced');
        return rows[0];
      };

      return { provider, modelId, embedQuery, embedDocuments };
    }

    // Not implemented in v1.
    return null;
  })();

  providerCache.set(cacheKey, promise);
  return await promise;
}

export function resetEmbeddingsProviderCacheForTests(): void {
  providerCache.clear();
}

