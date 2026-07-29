import { describe, expect, it, vi } from 'vitest';

async function loadNativeModule() {
  return import('./HappierTerminalNative').catch((error: unknown) => error);
}

describe('HappierTerminalNative optional module loading', () => {
  it('returns null when Expo native module lookup throws', async () => {
    const mod = await loadNativeModule();
    expect(mod).toHaveProperty('readOptionalHappierTerminalNativeModuleFromExpoCore');
    expect(mod).toHaveProperty('HAPPIER_TERMINAL_NATIVE_MODULE_NAME');
    const native = mod as {
      HAPPIER_TERMINAL_NATIVE_MODULE_NAME: string;
      readOptionalHappierTerminalNativeModuleFromExpoCore: (expoCore: {
        requireOptionalNativeModule?: (moduleName: string) => unknown;
      } | null) => unknown;
    };
    const expoCore = {
      requireOptionalNativeModule: vi.fn(() => {
        throw new Error('native module registry unavailable');
      }),
    };

    expect(native.readOptionalHappierTerminalNativeModuleFromExpoCore(expoCore)).toBeNull();
    expect(expoCore.requireOptionalNativeModule).toHaveBeenCalledWith(native.HAPPIER_TERMINAL_NATIVE_MODULE_NAME);
  });

  it('returns null when the Expo native view manager lookup throws', async () => {
    const mod = await loadNativeModule();
    expect(mod).toHaveProperty('readOptionalHappierTerminalNativeViewManagerFromExpoCore');
    expect(mod).toHaveProperty('HAPPIER_TERMINAL_NATIVE_MODULE_NAME');
    const native = mod as {
      HAPPIER_TERMINAL_NATIVE_MODULE_NAME: string;
      readOptionalHappierTerminalNativeViewManagerFromExpoCore: (expoCore: {
        requireNativeViewManager?: (moduleName: string, viewName?: string) => unknown;
      } | null) => unknown;
    };
    const expoCore = {
      requireNativeViewManager: vi.fn(() => {
        throw new Error('native view registry unavailable');
      }),
    };

    expect(native.readOptionalHappierTerminalNativeViewManagerFromExpoCore(expoCore)).toBeNull();
    expect(expoCore.requireNativeViewManager).toHaveBeenCalledWith(
      native.HAPPIER_TERMINAL_NATIVE_MODULE_NAME,
      'HappierTerminalNativeView',
    );
  });
});
