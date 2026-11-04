import { describe, expect, it } from 'vitest';
import { resolveRetainedVersionIds } from './retentionPolicy.js';

describe('first-party retention', () => {
  it('does not reserve an arbitrary version when no rollback version exists', () => {
    expect(resolveRetainedVersionIds({
      orderedVersionIdsNewestFirst: ['3.0.0', '2.0.0', '1.0.0'],
      currentVersionId: '2.0.0', previousVersionId: null,
    })).toEqual({ keep: ['2.0.0'], prune: ['3.0.0', '1.0.0'] });
  });
  it('keeps current and previous without retaining a newer interrupted installation', () => {
    expect(resolveRetainedVersionIds({
      orderedVersionIdsNewestFirst: ['local-stable-1792190545251', '2.0.0', '1.0.0', '0.9.0'],
      currentVersionId: '2.0.0', previousVersionId: '1.0.0',
    })).toEqual({ keep: ['2.0.0', '1.0.0'], prune: ['local-stable-1792190545251', '0.9.0'] });
  });
});
