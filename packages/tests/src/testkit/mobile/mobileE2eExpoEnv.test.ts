import { describe, expect, it } from 'vitest';

import { createMobileE2eExpoEnv } from './mobileE2eExpoEnv';

describe('mobileE2eExpoEnv', () => {
  it('enables native E2E testID accessibility labels by default', () => {
    const env = createMobileE2eExpoEnv({});
    expect(env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS).toBe('1');
  });

  it('preserves an explicitly configured EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS', () => {
    const env = createMobileE2eExpoEnv({
      EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS: '0',
    });
    expect(env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS).toBe('0');
  });
});
