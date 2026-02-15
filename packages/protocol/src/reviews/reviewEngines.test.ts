import { describe, expect, it } from 'vitest';

import { getNativeReviewEngine, listNativeReviewEngines } from './reviewEngines.js';

describe('reviewEngines', () => {
  it('exposes CodeRabbit as a native review engine', () => {
    const all = listNativeReviewEngines();
    expect(all.map((e) => e.id)).toContain('coderabbit');
    expect(getNativeReviewEngine('coderabbit')?.title).toBe('CodeRabbit');
  });
});

