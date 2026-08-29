import type { NativeIrohModule } from './HappierIrohNative.types';

declare const require: ((id: string) => unknown) | undefined;

export const HAPPIER_IROH_NATIVE_MODULE_NAME = 'HappierIrohNative';

type ExpoModulesCoreLike = Readonly<{
  requireOptionalNativeModule?: (moduleName: string) => unknown;
}>;

function requireExpoModulesCore(): ExpoModulesCoreLike | null {
  if (typeof require !== 'function') return null;
  try {
    const mod = require('expo-modules-core');
    return mod && typeof mod === 'object' ? (mod as ExpoModulesCoreLike) : null;
  } catch {
    return null;
  }
}

export function readOptionalHappierIrohNativeModuleFromExpoCore(
  expoCore: ExpoModulesCoreLike | null,
): NativeIrohModule | null {
  const lookup = expoCore?.requireOptionalNativeModule;
  if (typeof lookup !== 'function') return null;
  try {
    const module = lookup(HAPPIER_IROH_NATIVE_MODULE_NAME);
    if (!module || typeof module !== 'object') return null;
    const candidate = module as Record<string, unknown>;
    return typeof candidate.startHomeTunnel === 'function' && typeof candidate.stopHomeTunnel === 'function'
      ? (module as NativeIrohModule)
      : null;
  } catch {
    return null;
  }
}

export function getOptionalHappierIrohNativeModule(): NativeIrohModule | null {
  return readOptionalHappierIrohNativeModuleFromExpoCore(requireExpoModulesCore());
}
