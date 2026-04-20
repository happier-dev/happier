import { describe, expect, it } from 'vitest';

import { isKokoroRuntimeSupported } from '@/voice/kokoro/runtime/kokoroSupport';

describe('kokoroSupport', () => {
  it('returns false on web now that browser Kokoro is no longer supported', () => {
    expect(
      isKokoroRuntimeSupported({
        fetch: globalThis.fetch,
        Response: (globalThis as any).Response,
        TextEncoder: (globalThis as any).TextEncoder,
        WebAssembly: (globalThis as any).WebAssembly,
      } as any),
    ).toBe(false);
  });

  it('returns false on native when the native module is unavailable', () => {
    expect(
      isKokoroRuntimeSupported(
        {
          fetch: globalThis.fetch,
          Response: (globalThis as any).Response,
          TextEncoder: (globalThis as any).TextEncoder,
          WebAssembly: undefined,
        } as any,
        { platformOs: 'ios', hasNativeModule: false },
      ),
    ).toBe(false);
  });

  it('returns false when native runtime requirements are missing on web-shaped globals', () => {
    expect(
      isKokoroRuntimeSupported({
        fetch: globalThis.fetch,
        Response: (globalThis as any).Response,
        TextEncoder: (globalThis as any).TextEncoder,
        WebAssembly: undefined,
      } as any),
    ).toBe(false);
  });

  it('returns true on native when the native module is available (even without WebAssembly)', () => {
    expect(
      isKokoroRuntimeSupported(
        {
          fetch: globalThis.fetch,
          Response: (globalThis as any).Response,
          TextEncoder: (globalThis as any).TextEncoder,
          WebAssembly: undefined,
        } as any,
        { platformOs: 'ios', hasNativeModule: true },
      ),
    ).toBe(true);
  });
});
