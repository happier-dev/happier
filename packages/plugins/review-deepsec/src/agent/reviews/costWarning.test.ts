import { describe, expect, it } from 'vitest';

import { buildDeepSecCostWarning } from './costWarning.js';
import { DEEPSEC_REVIEW_MODES } from './command.js';

describe('buildDeepSecCostWarning', () => {
  it.each(DEEPSEC_REVIEW_MODES)('requires consent for paid analysis regardless of scope (%s)', mode => {
    expect(buildDeepSecCostWarning({ mode, confirmedCostWarning: false })).toMatchObject({
      status: 'requires_confirmation',
      costClass: 'expensive',
    });
  });

  it.each(DEEPSEC_REVIEW_MODES)('consumes admitted consent without another confirmation (%s)', mode => {
    expect(buildDeepSecCostWarning({ mode, confirmedCostWarning: true })).toEqual({ status: 'ok' });
  });
});
