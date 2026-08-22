import { describe, expect, it } from 'vitest';

import {
  abortAutomationRunForAuthoritativeCancellation,
  isAuthoritativeAutomationRunCancellation,
} from './automationRunCancellation';

describe('Automation Run cancellation identity', () => {
  it('distinguishes authoritative Run cancellation from generic currentness aborts', () => {
    const generic = new AbortController();
    generic.abort();
    expect(isAuthoritativeAutomationRunCancellation(generic.signal)).toBe(false);

    const cancelledRun = new AbortController();
    abortAutomationRunForAuthoritativeCancellation(cancelledRun);
    expect(isAuthoritativeAutomationRunCancellation(cancelledRun.signal)).toBe(true);
  });
});
