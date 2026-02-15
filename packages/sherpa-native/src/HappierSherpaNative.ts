import { requireOptionalNativeModule } from 'expo-modules-core';

import type { SherpaNativeModule } from './HappierSherpaNative.types';

export const HAPPIER_SHERPA_NATIVE_MODULE_NAME = 'HappierSherpaNative';

export function getOptionalHappierSherpaNativeModule(): SherpaNativeModule | null {
  const mod = requireOptionalNativeModule(HAPPIER_SHERPA_NATIVE_MODULE_NAME) as SherpaNativeModule | null;
  return mod ?? null;
}
