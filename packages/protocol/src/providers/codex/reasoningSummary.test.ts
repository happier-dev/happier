import { describe, expect, it } from 'vitest';

import { resolveCodexReasoningSummaryOverride } from '../../index.js';

describe('resolveCodexReasoningSummaryOverride', () => {
  it('overrides summary generation only for an explicit preference', () => {
    expect(resolveCodexReasoningSummaryOverride('enabled')).toBe('auto');
    expect(resolveCodexReasoningSummaryOverride('disabled')).toBe('none');
    for (const preference of ['default', undefined, null, '', 'auto', 'none', 'enabled ', true, {}]) {
      expect(resolveCodexReasoningSummaryOverride(preference)).toBeUndefined();
    }
  });
});
