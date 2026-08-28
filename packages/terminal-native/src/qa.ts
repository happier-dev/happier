import { getOptionalHappierTerminalNativeModule } from './HappierTerminalNative';
import type {
  TerminalNativeModule,
  TerminalNativeQaCapabilities,
  TerminalNativeQaRendererCrashInjectionResult,
} from './HappierTerminalNative.types';

const NO_QA_CAPABILITIES: TerminalNativeQaCapabilities = Object.freeze({
  rendererCrashInjection: false,
});

export function getTerminalNativeQaCapabilities(
  nativeModule: TerminalNativeModule | null = getOptionalHappierTerminalNativeModule(),
): TerminalNativeQaCapabilities {
  if (!nativeModule?.getQaCapabilities) return NO_QA_CAPABILITIES;

  try {
    const value = nativeModule.getQaCapabilities();
    if (!isRecord(value) || value.rendererCrashInjection !== true) return NO_QA_CAPABILITIES;
    return { rendererCrashInjection: true };
  } catch {
    return NO_QA_CAPABILITIES;
  }
}

export async function injectTerminalNativeRendererCrashForQa(
  surfaceId: string,
  nativeModule: TerminalNativeModule | null = getOptionalHappierTerminalNativeModule(),
): Promise<TerminalNativeQaRendererCrashInjectionResult> {
  const normalizedSurfaceId = surfaceId.trim();
  if (!normalizedSurfaceId) return { injected: false, reason: 'surface-not-ready' };
  if (!nativeModule) return { injected: false, reason: 'native-module-missing' };
  if (!getTerminalNativeQaCapabilities(nativeModule).rendererCrashInjection || !nativeModule.qaInjectRendererCrash) {
    return { injected: false, reason: 'qa-disabled' };
  }

  try {
    const value = await nativeModule.qaInjectRendererCrash(normalizedSurfaceId);
    if (isRecord(value) && value.injected === true && value.surfaceId === normalizedSurfaceId) {
      return { injected: true, surfaceId: normalizedSurfaceId };
    }
    if (isRecord(value) && value.injected === false) {
      if (value.reason === 'surface-not-ready') return { injected: false, reason: 'surface-not-ready' };
      if (value.reason === 'qa-disabled') return { injected: false, reason: 'qa-disabled' };
    }
    return { injected: false, reason: 'invalid-response' };
  } catch {
    return { injected: false, reason: 'invalid-response' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
