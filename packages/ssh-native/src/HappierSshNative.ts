import type { NativeSshModule } from './HappierSshNative.types';

declare const require: ((id: string) => unknown) | undefined;

type ExpoModulesCoreLike = Readonly<{
  requireOptionalNativeModule?: (moduleName: string) => unknown;
}>;

export const HAPPIER_SSH_NATIVE_MODULE_NAME = 'HappierSshNative';

function requireExpoModulesCore(): ExpoModulesCoreLike | null {
  if (typeof require !== 'function') return null;

  try {
    const mod = require('expo-modules-core');
    return mod && typeof mod === 'object' ? (mod as ExpoModulesCoreLike) : null;
  } catch {
    return null;
  }
}

export function getOptionalHappierSshNativeModule(): NativeSshModule | null {
  const requireOptionalNativeModule = requireExpoModulesCore()?.requireOptionalNativeModule;
  if (typeof requireOptionalNativeModule !== 'function') return null;

  const mod = requireOptionalNativeModule(HAPPIER_SSH_NATIVE_MODULE_NAME);
  return mod && typeof mod === 'object' ? (mod as NativeSshModule) : null;
}
