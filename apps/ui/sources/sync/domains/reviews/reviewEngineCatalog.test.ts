import { describe, expect, it } from 'vitest';

import { resolveReviewEngineTarget } from './reviewEngineCatalog';

describe('resolveReviewEngineTarget', () => {
  it('preserves configured review target keys while routing catalog Agent ids as backends', () => {
    expect(resolveReviewEngineTarget('backend:review-bot:configured:review-bot')).toEqual({
      kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured',
    });
    expect(resolveReviewEngineTarget('acme.review/reviewer')).toEqual({
      kind: 'backend', backendId: 'acme.review/reviewer',
    });
  });
});
