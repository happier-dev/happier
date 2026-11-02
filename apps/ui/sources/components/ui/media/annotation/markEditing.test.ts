import { describe, expect, it } from 'vitest';
import type { ImageMarkV1 } from '@happier-dev/protocol';
import { constrainPoint, dragHandle, resizeMark, selectionHandles, translateMark } from './markEditing';

describe('mark editing in original image coordinates', () => {
  it('constrains squares, circles, arrow angles and movement without changing the anchor', () => {
    const from = { x: 50, y: 50 }, to = { x: 10, y: 30 };
    expect(constrainPoint('rectangle', from, to)).toEqual({ x: 10, y: 10 });
    expect(constrainPoint('ellipse', from, to)).toEqual({ x: 10, y: 10 });
    expect(constrainPoint('move', from, to)).toEqual({ x: 10, y: 50 });
    expect(constrainPoint('freehand', from, to)).toEqual({ x: 10, y: 50 });
    const arrow = constrainPoint('arrow', { x: 0, y: 0 }, { x: 20, y: 18 });
    expect(arrow.x).toBeCloseTo(arrow.y);
    expect(Math.hypot(arrow.x, arrow.y)).toBeCloseTo(Math.hypot(20, 18));
  });
  it('resizes across opposite corners, scales stroke points and keeps element boxes immutable', () => {
    const rectangle: ImageMarkV1 = { id: 'r', kind: 'rectangle', rect: { x: 10, y: 20, width: 40, height: 30 }, color: 'red', size: 'm' };
    expect(resizeMark(rectangle, 'nw', { x: 70, y: 80 })).toMatchObject({ rect: { x: 50, y: 50, width: 20, height: 30 } });
    const stroke: ImageMarkV1 = { id: 'f', kind: 'freehand', points: [{ x: 10, y: 20 }, { x: 50, y: 50 }], color: 'red', size: 'm' };
    expect(resizeMark(stroke, 'se', { x: 90, y: 80 })).toMatchObject({ points: [{ x: 10, y: 20 }, { x: 90, y: 80 }] });
    const element: ImageMarkV1 = { id: 'e', kind: 'element', rect: rectangle.rect, color: 'red', label: 'button' };
    expect(selectionHandles(element)).toEqual([]);
    expect(resizeMark(element, 'se', { x: 90, y: 80 })).toBe(element);
    expect(translateMark(element, 20, 30)).toBe(element);
  });
  it('drags a handle by the pointer travel, so pressing a handle without moving changes nothing', () => {
    const rectangle: ImageMarkV1 = { id: 'r', kind: 'rectangle', rect: { x: 10, y: 20, width: 40, height: 30 }, color: 'red', size: 'm' };
    // Pressed 9 px off the corner (inside its hit area): no travel, no edit.
    expect(dragHandle(rectangle, 'se', { x: 59, y: 58 }, { x: 59, y: 58 })).toBe(rectangle);
    expect(dragHandle(rectangle, 'se', { x: 59, y: 58 }, { x: 69, y: 63 })).toMatchObject({ rect: { x: 10, y: 20, width: 50, height: 35 } });
    const arrow: ImageMarkV1 = { id: 'a', kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 40, y: 0 }, color: 'red', size: 'm' };
    expect(dragHandle(arrow, 'to', { x: 44, y: 3 }, { x: 54, y: 3 })).toMatchObject({ to: { x: 50, y: 0 } });
  });
  it('Shift squares a box from its opposite corner and snaps an arrow end to 45 degrees', () => {
    const rectangle: ImageMarkV1 = { id: 'r', kind: 'rectangle', rect: { x: 10, y: 20, width: 40, height: 30 }, color: 'red', size: 'm' };
    expect(dragHandle(rectangle, 'se', { x: 50, y: 50 }, { x: 70, y: 55 }, { shift: true })).toMatchObject({ rect: { x: 10, y: 20, width: 60, height: 60 } });
    const arrow: ImageMarkV1 = { id: 'a', kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 40, y: 0 }, color: 'red', size: 'm' };
    const snapped = dragHandle(arrow, 'to', { x: 40, y: 0 }, { x: 40, y: 34 }, { shift: true });
    expect(snapped.kind === 'arrow' && snapped.to.x).toBeCloseTo(snapped.kind === 'arrow' ? snapped.to.y : 0);
  });
});
