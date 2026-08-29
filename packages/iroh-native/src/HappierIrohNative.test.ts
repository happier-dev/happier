import { describe, expect, it, vi } from 'vitest';
import {
  HAPPIER_IROH_NATIVE_MODULE_NAME,
  readOptionalHappierIrohNativeModuleFromExpoCore,
} from './HappierIrohNative';

describe('HappierIrohNative optional module loading', () => {
  it('returns null when native lookup throws', () => {
    const expoCore = { requireOptionalNativeModule: vi.fn(() => { throw new Error('missing'); }) };
    expect(readOptionalHappierIrohNativeModuleFromExpoCore(expoCore)).toBeNull();
    expect(expoCore.requireOptionalNativeModule).toHaveBeenCalledWith(HAPPIER_IROH_NATIVE_MODULE_NAME);
  });

  it('returns the lifecycle-only native module when present', () => {
    const native = { startHomeTunnel: vi.fn(), stopHomeTunnel: vi.fn() };
    const expoCore = { requireOptionalNativeModule: vi.fn(() => native) };
    expect(readOptionalHappierIrohNativeModuleFromExpoCore(expoCore)).toBe(native);
  });

  it('rejects a registered module that does not expose lifecycle methods', () => {
    const expoCore = { requireOptionalNativeModule: vi.fn(() => ({ getAvailability: () => ({}) })) };
    expect(readOptionalHappierIrohNativeModuleFromExpoCore(expoCore)).toBeNull();
  });
});
