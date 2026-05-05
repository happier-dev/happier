import { describe, expect, it } from 'vitest';

import { resolvePlaywrightWrapperTimeoutFallbackMs } from '../../../scripts/playwrightWrapperTimeout.mjs';

describe('resolvePlaywrightWrapperTimeoutFallbackMs', () => {
  it('gives local full UI Playwright runs more than the old smoke-test budget', () => {
    expect(resolvePlaywrightWrapperTimeoutFallbackMs({})).toBeGreaterThanOrEqual(90 * 60 * 1000);
  });

  it('keeps CI below the GitHub job timeout so wrapper cleanup can run', () => {
    expect(resolvePlaywrightWrapperTimeoutFallbackMs({ CI: '1' })).toBe(42 * 60 * 1000);
  });

  it('uses the explicit Playwright wrapper timeout override when provided', () => {
    expect(resolvePlaywrightWrapperTimeoutFallbackMs({ HAPPIER_PLAYWRIGHT_WRAPPER_TIMEOUT_MS: '1234' })).toBe(1234);
  });
});
