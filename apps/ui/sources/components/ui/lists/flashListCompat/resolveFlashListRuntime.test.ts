import * as React from 'react';
import { describe, expect, it } from 'vitest';

import { resolveFlashListRuntime } from './resolveFlashListRuntime';

describe('resolveFlashListRuntime', () => {
  it('returns the provider FlashList when the module is available', () => {
    const ProvidedFlashList = React.forwardRef(function ProvidedFlashList(_props: Record<string, unknown>, _ref: React.ForwardedRef<unknown>) {
      return null;
    });

    const runtime = resolveFlashListRuntime(() => ({ FlashList: ProvidedFlashList }));

    expect(runtime.usingFallback).toBe(false);
    expect(runtime.Component).toBe(ProvidedFlashList);
    expect(runtime.reason).toBeNull();
  });

  it('falls back when resolving the FlashList export throws', () => {
    const runtime = resolveFlashListRuntime(() => {
      const brokenModule: Record<string, unknown> = {};
      Object.defineProperty(brokenModule, 'FlashList', {
        enumerable: true,
        get() {
          throw new TypeError('require(...).__importStar is not a function');
        },
      });
      return brokenModule;
    });

    expect(runtime.usingFallback).toBe(true);
    expect(runtime.reason).toBe('flashlist_unavailable');
    expect(runtime.Component).not.toBeNull();
  });
});
