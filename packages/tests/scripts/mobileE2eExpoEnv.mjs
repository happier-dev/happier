export function createMobileE2eExpoEnv(env) {
  return {
    ...env,
    EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS:
      typeof env?.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS === 'string'
        ? env.EXPO_PUBLIC_HAPPIER_NATIVE_E2E_TEST_IDS
        : '1',
  };
}
