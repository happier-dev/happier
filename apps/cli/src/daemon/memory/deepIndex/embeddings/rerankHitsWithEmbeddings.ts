export type EmbeddingRerankWeights = Readonly<{ wFts: number; wEmb: number }>;

export type EmbeddingRerankHit = Readonly<{
  id: string;
  baseScore: number;
  embedding: Float32Array | null;
}>;

export type EmbeddingRerankResult = ReadonlyArray<
  Readonly<{
    id: string;
    baseScore: number;
    embedding: Float32Array | null;
    cosineSimilarity: number | null;
    finalScore: number;
  }>
>;

function clampFinite(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number | null {
  if (!(a instanceof Float32Array) || !(b instanceof Float32Array)) return null;
  if (a.length === 0 || b.length === 0) return null;
  if (a.length !== b.length) return null;

  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i]!;
    const bv = b[i]!;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA <= 0 || normB <= 0) return null;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function rerankHitsWithEmbeddings(params: Readonly<{
  hits: ReadonlyArray<EmbeddingRerankHit>;
  queryEmbedding: Float32Array;
  weights: EmbeddingRerankWeights;
}>): EmbeddingRerankResult {
  const wFts = clampFinite(params.weights.wFts, 0, 10);
  const wEmb = clampFinite(params.weights.wEmb, 0, 10);

  const enriched = params.hits.map((hit, index) => {
    const baseScore = clampFinite(Number(hit.baseScore ?? 0), 0, 1);
    const cos = hit.embedding ? cosineSimilarity(params.queryEmbedding, hit.embedding) : null;
    const embScore = cos === null ? null : (cos + 1) / 2;

    const finalScore =
      embScore === null
        ? baseScore
        : clampFinite(wFts * baseScore + wEmb * clampFinite(embScore, 0, 1), 0, 10);

    return {
      index,
      id: String(hit.id ?? ''),
      baseScore,
      embedding: hit.embedding ?? null,
      cosineSimilarity: cos,
      finalScore,
    };
  });

  enriched.sort((a, b) => {
    if (b.finalScore !== a.finalScore) return b.finalScore - a.finalScore;
    return a.index - b.index;
  });

  return enriched.map(({ index: _index, ...rest }) => rest);
}

