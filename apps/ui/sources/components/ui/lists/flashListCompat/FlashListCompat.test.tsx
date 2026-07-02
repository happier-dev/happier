import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';

import type { FlashListMappingKey, FlashListRef } from '@/components/ui/lists/flashListCompat/FlashListCompat';

type CompatTypeTestItem = Readonly<{ id: string }>;

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

  it('keeps FlashList v2 measurement methods optional on the compat ref type', () => {
    const fallbackRef = {
      scrollToIndex: () => undefined,
      scrollToOffset: () => undefined,
    } satisfies FlashListRef<CompatTypeTestItem>;

    expect(typeof fallbackRef.scrollToIndex).toBe('function');
  });

  it('accepts FlashList v2 bigint mapping keys on the compat type surface', () => {
    const mappingKey = BigInt(1) satisfies FlashListMappingKey;

    expect(typeof mappingKey).toBe('bigint');
  });

  it('accepts FlashList v2 scroll offsets and measurement methods on the compat ref type', () => {
    const calls: Array<{ index: number; viewOffset?: number }> = [];
    const flashListV2Ref = {
      scrollToIndex: (params: { index: number; animated?: boolean; viewPosition?: number; viewOffset?: number }) => {
        calls.push({ index: params.index, viewOffset: params.viewOffset });
      },
      scrollToOffset: () => undefined,
      computeVisibleIndices: () => ({ startIndex: 1, endIndex: 2 }),
      getFirstVisibleIndex: () => 1,
      getLayout: (index: number) => ({ x: 0, y: index * 40, width: 320, height: 40 }),
      getAbsoluteLastScrollOffset: () => 80,
    } satisfies FlashListRef<CompatTypeTestItem>;

    flashListV2Ref.scrollToIndex({ index: 2, animated: false, viewOffset: 24 });

    expect(calls).toEqual([{ index: 2, viewOffset: 24 }]);
  });

  it('exposes the FlashList v2 layout and recycling hook surface through the compat seam', async () => {
    vi.doUnmock('@/components/ui/lists/flashListCompat/FlashListCompat');
    vi.doMock('@shopify/flash-list', () => ({
      FlashList: React.forwardRef(function ProvidedFlashList() {
        return null;
      }),
      LayoutCommitObserver: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
      useLayoutState: <T,>(initialState: T) => [initialState, vi.fn()] as const,
      useMappingHelper: () => ({ getMappingKey: (_itemKey: string, index: number) => index }),
      useRecyclingState: <T,>(initialState: T) => [initialState, vi.fn()] as const,
    }));

    const module = await import('@/components/ui/lists/flashListCompat/FlashListCompat');

    expect(typeof module.LayoutCommitObserver).toBe('function');
    expect(typeof module.useLayoutState).toBe('function');
    expect(typeof module.useMappingHelper).toBe('function');
    expect(typeof module.useRecyclingState).toBe('function');
    expect(module.useMappingHelper().getMappingKey('row-id', 3)).toBe('row-id');
  });
});
