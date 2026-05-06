import { describe, expect, it } from 'vitest';

import { resolveReviewOutputNormalizer } from './reviewEngineRegistry';

describe('reviewEngineRegistry', () => {
  it('does not resolve provider-specific review output normalizers from the host-generic registry', () => {
    const legacyProviderId = ['code', 'rabbit'].join('');

    expect(resolveReviewOutputNormalizer(legacyProviderId)).toBeNull();
  });

  it('does not provide a review normalizer for unknown review backends', () => {
    expect(resolveReviewOutputNormalizer('acme.review.backend')).toBeNull();
  });
});
