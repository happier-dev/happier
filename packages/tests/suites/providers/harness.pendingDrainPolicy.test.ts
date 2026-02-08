import { afterEach, describe, expect, it } from 'vitest';

import { shouldAssertPendingDrain } from '../../src/testkit/providers/harness';

describe('providers harness: pending drain policy', () => {
  const original = process.env.HAPPIER_E2E_PROVIDER_ASSERT_PENDING_EMPTY;

  afterEach(() => {
    process.env.HAPPIER_E2E_PROVIDER_ASSERT_PENDING_EMPTY = original;
  });

  it('disables pending drain when scenario opts out', () => {
    delete process.env.HAPPIER_E2E_PROVIDER_ASSERT_PENDING_EMPTY;
    expect(shouldAssertPendingDrain({ assertPendingDrain: false })).toBe(false);
  });

  it('disables pending drain when env flag is false', () => {
    process.env.HAPPIER_E2E_PROVIDER_ASSERT_PENDING_EMPTY = '0';
    expect(shouldAssertPendingDrain({ assertPendingDrain: true })).toBe(false);
  });

  it('enables pending drain by default', () => {
    delete process.env.HAPPIER_E2E_PROVIDER_ASSERT_PENDING_EMPTY;
    expect(shouldAssertPendingDrain({})).toBe(true);
  });
});
