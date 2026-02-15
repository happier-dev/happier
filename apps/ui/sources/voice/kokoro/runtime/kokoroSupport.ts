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

  // On native, Kokoro is supported only through the Sherpa-backed native module.
  if (platformOs !== 'web') {
    return typeof overrides.hasNativeModule === 'boolean' ? overrides.hasNativeModule : getHasNativeKokoroModule();
  }

  // On web, Kokoro (via transformers + onnxruntime-web) requires fetch/Response and WebAssembly for the default WASM backend.
  // If any required runtime primitive is missing, avoid attempting to initialize the runtime.
  if (typeof globals.fetch !== 'function') return false;
  if (typeof (globals as any).Response === 'undefined') return false;
  if (typeof (globals as any).WebAssembly === 'undefined') return false;
  if (typeof (globals as any).TextEncoder === 'undefined') return false;
  return true;
}
