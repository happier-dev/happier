import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

import { isHappierTouchPrimaryPointer, resolveHappierHitInsets, useHappierPrecisePrimaryPointer, useHappierTouchPrimaryPointer, useHappierTouchTargetSize } from './interactiveTarget.js';

describe('the shared hit-area policy', () => {
  it('reaches the target past a small drawn box without asking it to grow', () => {
    expect(resolveHappierHitInsets({ width: 32, height: 32, target: 44 }))
      .toEqual({ top: 6, bottom: 6, left: 6, right: 6 });
  });

  it('splits a tight gap between neighbours instead of overlapping them', () => {
    // Two 24 px controls 4 px apart: each reaches 2 px toward the other and the full deficit elsewhere.
    const leading = resolveHappierHitInsets({ width: 24, height: 24, target: 44, reach: { right: 2 } });
    const trailing = resolveHappierHitInsets({ width: 24, height: 24, target: 44, reach: { left: 2 } });
    expect(leading).toEqual({ top: 10, bottom: 10, left: 10, right: 2 });
    expect(trailing).toEqual({ top: 10, bottom: 10, left: 2, right: 10 });
    expect(leading!.right + trailing!.left).toBeLessThanOrEqual(4);
  });

  it('extends nothing under a precise pointer, for a box already at the target, or on an unknown axis', () => {
    expect(resolveHappierHitInsets({ width: 24, height: 24, target: undefined })).toBeUndefined();
    expect(resolveHappierHitInsets({ width: 48, height: 44, target: 44 })).toBeUndefined();
    expect(resolveHappierHitInsets({ height: 32, target: 44 })).toEqual({ top: 6, bottom: 6, left: 0, right: 0 });
  });
});

describe('the primary pointer fact', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is a finger on a native touch platform and in a browser that cannot hover, never on a hovering desktop', () => {
    const media = (matching: readonly string[]) => (query: string) => ({ matches: matching.includes(query) });
    vi.stubGlobal('matchMedia', media(['(pointer: fine)', '(hover: hover)']));
    expect(isHappierTouchPrimaryPointer('web')).toBe(false);
    expect(isHappierTouchPrimaryPointer('ios')).toBe(true);
    expect(isHappierTouchPrimaryPointer('android')).toBe(true);

    vi.stubGlobal('matchMedia', media(['(pointer: coarse)', '(hover: none)']));
    expect(isHappierTouchPrimaryPointer('web')).toBe(true);
    expect(isHappierTouchPrimaryPointer(undefined)).toBe(true);
  });

  it('updates mounted touch targets in both directions, sharing media listeners and ignoring unchanged facts', async () => {
    let coarse = false;
    const queries = new Map<string, { matches: boolean; listeners: Set<() => void> }>();
    vi.stubGlobal('matchMedia', (query: string) => {
      const media = queries.get(query) ?? { matches: query === '(pointer: coarse)' || query === '(hover: none)' ? coarse : !coarse, listeners: new Set<() => void>() };
      queries.set(query, media);
      return {
        get matches() { return media.matches; },
        addEventListener: (_event: string, listener: () => void) => media.listeners.add(listener),
        removeEventListener: (_event: string, listener: () => void) => media.listeners.delete(listener),
      };
    });
    const changePointer = (value: boolean) => {
      coarse = value;
      for (const [query, media] of queries) media.matches = query === '(pointer: coarse)' || query === '(hover: none)' ? coarse : !coarse;
      for (const media of queries.values()) for (const listener of media.listeners) listener();
    };
    const sizes: Array<44 | 48 | undefined> = [];
    const pointers: boolean[] = [];
    function Target() {
      pointers.push(useHappierTouchPrimaryPointer('web'));
      sizes.push(useHappierTouchTargetSize());
      return null;
    }
    let mounted: ReactTestRenderer | undefined;
    try {
      await act(async () => { mounted = create(createElement('targets', null, createElement(Target), createElement(Target))); });
      expect(sizes).toEqual([undefined, undefined]);
      expect(pointers).toEqual([false, false]);
      sizes.length = 0;
      pointers.length = 0;
      await act(async () => changePointer(true));
      expect(sizes).toEqual([44, 44]);
      expect(pointers).toEqual([true, true]);
      expect([...queries.keys()].sort()).toEqual(['(hover: hover)', '(hover: none)', '(pointer: coarse)', '(pointer: fine)']);
      expect([...queries.values()].map(media => media.listeners.size)).toEqual([1, 1, 1, 1]);
      sizes.length = 0;
      pointers.length = 0;
      await act(async () => changePointer(true));
      expect(sizes).toEqual([]);
      expect(pointers).toEqual([]);
      await act(async () => changePointer(false));
      expect(sizes).toEqual([undefined, undefined]);
      expect(pointers).toEqual([false, false]);
    } finally {
      await act(async () => mounted?.unmount());
    }
    expect([...queries.values()].map(media => media.listeners.size)).toEqual([0, 0, 0, 0]);
    changePointer(true);
    expect(isHappierTouchPrimaryPointer('web')).toBe(true);
  });

  it('keeps fine or hover precedence and uses touch points only when media give no answer', () => {
    vi.stubGlobal('navigator', { maxTouchPoints: 5 });
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    expect(isHappierTouchPrimaryPointer('web')).toBe(false);
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(isHappierTouchPrimaryPointer('web')).toBe(true);
    vi.stubGlobal('matchMedia', () => { throw new Error('Pointer media unavailable'); });
    expect(isHappierTouchPrimaryPointer('web')).toBe(true);
    vi.stubGlobal('navigator', { maxTouchPoints: 0 });
    expect(isHappierTouchPrimaryPointer('web')).toBe(false);
  });

  it('updates strict hover affordances even when the coarse-pointer classification stays unchanged', async () => {
    let fine = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', (query: string) => ({
      get matches() { return query === '(hover: hover)' || query === '(pointer: fine)' && fine; },
      addEventListener: (_event: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_event: string, listener: () => void) => listeners.delete(listener),
    }));
    let current: Readonly<{ touch: boolean; precise: boolean }> | undefined;
    function Target() {
      current = { touch: useHappierTouchPrimaryPointer('web'), precise: useHappierPrecisePrimaryPointer('web') };
      return null;
    }
    let mounted: ReactTestRenderer | undefined;
    try {
      await act(async () => { mounted = create(createElement(Target)); });
      expect(current).toEqual({ touch: false, precise: false });
      await act(async () => { fine = true; for (const listener of listeners) listener(); });
      expect(current).toEqual({ touch: false, precise: true });
    } finally {
      await act(async () => mounted?.unmount());
    }
  });
});
