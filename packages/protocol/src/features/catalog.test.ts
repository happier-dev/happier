import { describe, expect, it } from 'vitest';

import { FEATURE_CATALOG, FEATURE_IDS, isFeatureId } from './catalog.js';

describe('feature catalog', () => {
  it('contains unique feature ids', () => {
    const unique = new Set(FEATURE_IDS);
    expect(unique.size).toBe(FEATURE_IDS.length);
  });

  it('does not include legacy inbox.friends feature id', () => {
    expect(isFeatureId('inbox.friends')).toBe(false);
  });

  it('includes files feature ids', () => {
    expect(isFeatureId('files.reviewComments')).toBe(true);
    expect(isFeatureId('files.diffSyntaxHighlighting')).toBe(true);
    expect(isFeatureId('files.editor')).toBe(true);
    expect(isFeatureId('files.syntaxHighlighting.advanced')).toBe(true);
  });

  it('includes execution runs feature id', () => {
    expect(isFeatureId('execution.runs')).toBe(true);
  });

  it('maps every catalog entry to a known feature id', () => {
    for (const entry of FEATURE_CATALOG) {
      expect(isFeatureId(entry.id)).toBe(true);
    }
  });

  it('marks all features fail closed by default', () => {
    for (const entry of FEATURE_CATALOG) {
      expect(entry.defaultFailMode).toBe('fail_closed');
    }
  });
});
