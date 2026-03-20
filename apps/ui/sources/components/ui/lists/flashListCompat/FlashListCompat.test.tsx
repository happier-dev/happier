import { afterEach, describe, expect, it, vi } from 'vitest';

describe('FlashListCompat', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('@shopify/flash-list');
    vi.doUnmock('@/components/ui/lists/flashListCompat/FlashListCompat');
  });

  it('falls back when the FlashList module throws during import', async () => {
    vi.doUnmock('@/components/ui/lists/flashListCompat/FlashListCompat');
    vi.doMock('@shopify/flash-list', () => {
      throw new TypeError('require(...).__importStar is not a function');
    });

    const module = await import('@/components/ui/lists/flashListCompat/FlashListCompat');

    expect(module.flashListRuntime.usingFallback).toBe(true);
    expect(module.flashListRuntime.reason).toBe('flashlist_unavailable');
    expect(module.FlashList).toBeDefined();
  });
});
