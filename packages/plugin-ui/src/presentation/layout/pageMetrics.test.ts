import { describe, expect, it } from 'vitest';

import { isHappierSectionActionStacked } from './pageMetrics.js';

describe('isHappierSectionActionStacked', () => {
  // A Work pane section at the pane's default width: a short title beside an ⓘ and a +.
  const narrowPane = { headerWidthPx: 251, actionWidthPx: 70, gapPx: 12 };

  it('moves a labelled action under the text when the text column would get too narrow', () => {
    expect(isHappierSectionActionStacked({ ...narrowPane, actionLayout: 'inline' })).toBe(true);
  });

  it('keeps a trailing icon cluster on the title line at any width', () => {
    expect(isHappierSectionActionStacked({ ...narrowPane, actionLayout: 'trailing' })).toBe(false);
    expect(isHappierSectionActionStacked({ headerWidthPx: 180, actionWidthPx: null, actionLayout: 'trailing', gapPx: 12 })).toBe(false);
  });
});
