import { describe, expect, it } from 'vitest';

import { resolveReviewOutputNormalizer } from './reviewEngineRegistry';

describe('reviewEngineRegistry', () => {
  it('does not provide descriptor-backed review output normalization after runtimeCore convergence', () => {
    expect(resolveReviewOutputNormalizer('acme.review.backend')).toBeNull();
  });
});
