import { describe, expect, it } from 'vitest';
import {
  getWidgetSupportedSizesV1, getWidgetSizeFootprintV1, getSessionBoardWidgetFootprintV1,
  normalizeWidgetSizeForSurfaceV1, resolveSessionBoardWidgetSizeV1, resolveWidgetSizeChoicesV1,
  stepWidgetSizeV1, WidgetSizeDeclarationV1Schema, WidgetSessionBoardWidthV1Schema, WidgetSurfacePresentationV1Schema, WidgetExpectedPresentationV1Schema, WIDGET_SIZE_ORDER_V1,
} from './widgetPresentationV1.js';
import type { WidgetSurfaceRefV1 } from './widgetInstanceV1.js';

describe('portable widget size policy', () => {
  it('retains explicit ungrouped presentation custody without treating it as an omitted expectation', () => {
    const capture = { nativeIndex: 0, frameStyle: null, groupId: null };
    expect(WidgetExpectedPresentationV1Schema.parse(capture)).toEqual(capture);
    expect(WidgetExpectedPresentationV1Schema.safeParse({ ...capture, groupId: '' }).success).toBe(false);
  });
  it('advertises two-dimensional size choices rather than width-only presentation', () => {
    expect(WidgetSurfacePresentationV1Schema.safeParse({ sizes: ['tall', 'full'], defaultSize: 'tall' }).success).toBe(true);
  });
  it.each(['home', 'workBoard', 'pluginArea', 'sessionBoard'] as const)('preserves every supported %s move size', kind => {
    expect(getWidgetSupportedSizesV1(kind)).toEqual(WIDGET_SIZE_ORDER_V1);
    for (const size of WIDGET_SIZE_ORDER_V1) expect(normalizeWidgetSizeForSurfaceV1(kind, size)).toBe(size);
    expect(normalizeWidgetSizeForSurfaceV1(kind)).toBe('medium');
  });
  it.each(['project', 'companion'] satisfies WidgetSurfaceRefV1['owner']['kind'][])('keeps %s linear', kind => {
    expect(resolveWidgetSizeChoicesV1(kind, { sizes: ['tall'], defaultSize: 'tall' })).toEqual({ sizes: [] });
    expect(normalizeWidgetSizeForSurfaceV1(kind, 'tall')).toBeUndefined();
  });
  it('intersects and normalizes declarations once without conflating equal-area aspects', () => {
    const declaration = WidgetSizeDeclarationV1Schema.parse({ sizes: ['tall', 'full', 'small'], defaultSize: 'tall' });
    expect(resolveWidgetSizeChoicesV1('home', declaration)).toEqual({ sizes: ['small', 'full', 'tall'], defaultSize: 'tall' });
    expect(normalizeWidgetSizeForSurfaceV1('home', 'large', declaration)).toBe('tall');
    const tall = getWidgetSizeFootprintV1('home', 'tall')!;
    const full = getWidgetSizeFootprintV1('home', 'full')!;
    expect(tall.columnSpan * tall.rowSpan).toBe(full.columnSpan * full.rowSpan);
    expect(tall.columnSpan).not.toBe(full.columnSpan);
    expect(tall.height).not.toBe(full.height);
    expect(WidgetSizeDeclarationV1Schema.safeParse({ sizes: ['small'], defaultSize: 'tall' }).success).toBe(false);
  });
  it('steps through the same canonical order and clamps at the ends', () => {
    const choices = ['tall', 'small', 'full'] as const;
    expect(stepWidgetSizeV1(choices, 'small', -1)).toBe('small');
    expect(stepWidgetSizeV1(choices, 'small', 1)).toBe('full');
    expect(stepWidgetSizeV1(choices, 'tall', 1)).toBe('tall');
    expect(stepWidgetSizeV1([], 'small', 1)).toBeUndefined();
  });
  it('preserves native Board heights, including unnamed rectangles and Auto fallback', () => {
    expect(resolveSessionBoardWidgetSizeV1('compact', { mode: 'fixed', size: 'tall' })).toBeUndefined();
    expect(resolveSessionBoardWidgetSizeV1('wide', { mode: 'auto', fallback: 'regular' })).toBeUndefined();
    expect(resolveSessionBoardWidgetSizeV1('medium', { mode: 'fixed', size: 'tall' })).toBe('tall');
    expect(resolveSessionBoardWidgetSizeV1('full', { mode: 'auto', fallback: 'tall' })).toBe('large');
    expect(getSessionBoardWidgetFootprintV1('compact', { mode: 'fixed', size: 'tall' })).toMatchObject({
      width: 'compact', columnSpan: 4, height: 'tall', rowSpan: 4,
    });
    expect(getSessionBoardWidgetFootprintV1('wide', { mode: 'auto', fallback: 'regular' })).toMatchObject({
      width: 'wide', columnSpan: 8, height: 'regular', rowSpan: 2,
    });
  });
  it('names only exact Board width and authoritative height pairs', () => {
    for (const size of WIDGET_SIZE_ORDER_V1) {
      const footprint = getWidgetSizeFootprintV1('sessionBoard', size)!;
      const width = WidgetSessionBoardWidthV1Schema.parse(footprint.width);
      expect(resolveSessionBoardWidgetSizeV1(width, { mode: 'fixed', size: footprint.height })).toBe(size);
      expect(resolveSessionBoardWidgetSizeV1(width, { mode: 'auto', fallback: footprint.height })).toBe(size);
    }
  });
});
