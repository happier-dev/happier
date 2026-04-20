import { Platform } from 'react-native';

type KokoroSupportOverrides = {
  platformOs?: string;
  hasNativeModule?: boolean;
};

function getHasNativeKokoroModule(): boolean {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('@happier-dev/sherpa-native') as any;
    const getter = mod?.getOptionalHappierSherpaNativeModule;
    if (typeof getter !== 'function') return false;
    return Boolean(getter());
  } catch {
    return false;
  }
}

export function isKokoroRuntimeSupported(
  globals: Partial<typeof globalThis> = globalThis,
  overrides: KokoroSupportOverrides = {},
): boolean {
  const platformOs = overrides.platformOs ?? Platform.OS;

  if (platformOs === 'web') return false;

  // On native, Kokoro is supported only through the Sherpa-backed native module.
  void globals;
  return typeof overrides.hasNativeModule === 'boolean' ? overrides.hasNativeModule : getHasNativeKokoroModule();
}
