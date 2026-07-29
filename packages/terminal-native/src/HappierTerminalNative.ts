import type { TerminalNativeModule } from './HappierTerminalNative.types';

declare const require: ((id: string) => unknown) | undefined;

type ExpoModulesCoreLike = Readonly<{
  requireOptionalNativeModule?: (moduleName: string) => unknown;
  requireNativeViewManager?: (moduleName: string, viewName?: string) => unknown;
}>;

export const HAPPIER_TERMINAL_NATIVE_MODULE_NAME = 'HappierTerminalNative';
export const HAPPIER_TERMINAL_NATIVE_VIEW_NAME = 'HappierTerminalNativeView';

function requireExpoModulesCore(): ExpoModulesCoreLike | null {
  if (typeof require !== 'function') return null;

  try {
    const mod = require('expo-modules-core');
    return mod && typeof mod === 'object' ? (mod as ExpoModulesCoreLike) : null;
  } catch {
    return null;
  }
}

export function getOptionalHappierTerminalNativeModule(): TerminalNativeModule | null {
  return readOptionalHappierTerminalNativeModuleFromExpoCore(requireExpoModulesCore());
}

export function getOptionalHappierTerminalNativeViewManager<TView = unknown>(): TView | null {
  return readOptionalHappierTerminalNativeViewManagerFromExpoCore<TView>(requireExpoModulesCore());
}

export function readOptionalHappierTerminalNativeModuleFromExpoCore(
  expoCore: ExpoModulesCoreLike | null,
): TerminalNativeModule | null {
  const requireOptionalNativeModule = expoCore?.requireOptionalNativeModule;
  if (typeof requireOptionalNativeModule !== 'function') return null;

  let mod: unknown;
  try {
    mod = requireOptionalNativeModule(HAPPIER_TERMINAL_NATIVE_MODULE_NAME);
  } catch {
    return null;
  }
  return mod && typeof mod === 'object' ? (mod as TerminalNativeModule) : null;
}

export function readOptionalHappierTerminalNativeViewManagerFromExpoCore<TView = unknown>(
  expoCore: ExpoModulesCoreLike | null,
): TView | null {
  const requireNativeViewManager = expoCore?.requireNativeViewManager;
  if (typeof requireNativeViewManager !== 'function') return null;

  try {
    return requireNativeViewManager(
      HAPPIER_TERMINAL_NATIVE_MODULE_NAME,
      HAPPIER_TERMINAL_NATIVE_VIEW_NAME,
    ) as TView;
  } catch {
    return null;
  }
}
