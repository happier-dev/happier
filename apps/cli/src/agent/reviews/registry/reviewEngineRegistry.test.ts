import { describe, expect, it } from 'vitest';

import { listNativeReviewEngines } from '@happier-dev/protocol';

import { resolveReviewOutputNormalizer } from './reviewEngineRegistry';

describe('reviewEngineRegistry', () => {
  it('provides a review output normalizer for every native review engine', () => {
    for (const engine of listNativeReviewEngines()) {
      expect(resolveReviewOutputNormalizer(engine.id)).toBeTruthy();
    }
  });
});

