import { describe, expect, it } from 'vitest';

import { createFeatureExtractionPipelineWithFallback } from './createLocalTransformersEmbeddingsProvider';

describe('createLocalTransformersEmbeddingsProvider shared foundation', () => {
  it('still creates a package-backed feature-extraction pipeline through the shared runtime loader', async () => {
    const extractor = await createFeatureExtractionPipelineWithFallback({
      modelId: 'Xenova/all-MiniLM-L6-v2',
      cacheDir: '/tmp/happier-memory-embeddings-test',
      runtimeAssetExists: () => false,
      packageImport: async () => ({
        env: {},
        pipeline: async () => {
          return async () => ({
            data: new Float32Array([0.5, 0.25]),
            dims: [1, 2],
          });
        },
      }),
    });

    await expect(extractor(['hello'], { pooling: 'mean', normalize: true })).resolves.toEqual({
      data: new Float32Array([0.5, 0.25]),
      dims: [1, 2],
    });
  });
});
