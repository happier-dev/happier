import { Dimensions } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { renderHook } from '@/dev/testkit/hooks/renderHook';

import { resolveEffectiveDiffPresentation, resolveProseDiffPresentation, useEffectiveDiffWrapLines } from './diffPresentationStyle';

afterEach(() => { standardCleanup(); vi.restoreAllMocks(); });

describe('diff presentation', () => {
    it('keeps prose two-sided where a code split would be unified, and stacks it below the prose minimum', () => {
        expect(resolveEffectiveDiffPresentation({ preference: 'split', availableWidthPx: 700 }).style).toBe('unified');
        expect(resolveProseDiffPresentation(700)).toBe('split');
        expect(resolveProseDiffPresentation(390)).toBe('unified');
        expect(resolveProseDiffPresentation(null)).toBe('split');
    });

    it('leaves the code split rule unchanged', () => {
        expect(resolveEffectiveDiffPresentation({ preference: 'split', availableWidthPx: 1200 }).style).toBe('split');
        expect(resolveEffectiveDiffPresentation({ preference: 'unified', availableWidthPx: 1200 }).style).toBe('unified');
    });
});

describe('phone diff wrapping', () => {
    it('reads the same hooks whether or not the screen is a phone, so crossing the phone width keeps React hook order (IMPL-04V-C)', async () => {
        // Dimensions is the device-type authority; the viewport crosses the phone width between renders.
        const viewport = { width: 390, height: 844, scale: 1, fontScale: 1 };
        vi.spyOn(Dimensions, 'get').mockImplementation(() => viewport);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const hook = await renderHook(() => useEffectiveDiffWrapLines(false));
        expect(hook.getCurrent()).toBe(true);
        Object.assign(viewport, { width: 1440, height: 900 });
        expect(await hook.rerender()).toBe(false);
        Object.assign(viewport, { width: 390, height: 844 });
        expect(await hook.rerender()).toBe(true);
        const hookOrder = errors.mock.calls.filter((call) => /order of Hooks|Rendered (more|fewer) hooks/.test(String(call[0])));
        expect(hookOrder).toEqual([]);
        await hook.unmount();
    });
});
