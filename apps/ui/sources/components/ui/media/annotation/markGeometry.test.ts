import { describe, expect, it } from 'vitest';
import type { ImageMarkV1 } from '@happier-dev/protocol';
import { cropOverlayPaths, getMarkGeometry, hitTestMarks, freehandPath, appendFreehandSegment, resolveCropView } from './markGeometry';

describe('shared mark geometry', () => {
  it('names an element in a filled tag over its box, and inside it when the box touches the top', () => {
    const element: ImageMarkV1 = { id: 'e', kind: 'element', rect: { x: 40, y: 200, width: 300, height: 60 }, label: 'TotalRow', color: 'red' };
    const measure = (text: string, fontSize: number) => text.length * fontSize / 2;
    const { paths, texts, bounds } = getMarkGeometry(element, 2, 1, measure);
    expect(texts.map((text) => text.text)).toEqual(['TotalRow']);
    expect(paths).toHaveLength(2);
    expect(paths[1]).toMatchObject({ fill: '#FF3B30' });
    expect(texts[0]!.y).toBeLessThan(200);
    expect(bounds).toEqual(element.rect);
    const atTop = getMarkGeometry({ ...element, rect: { ...element.rect, y: 0 } }, 2, 1, measure);
    expect(atTop.texts[0]!.y).toBeGreaterThan(0);
  });
  it('hits the head of a thick reversed arrow and keeps its visible head inside selection bounds', () => {
    const arrow: ImageMarkV1 = { id: 'arrow', kind: 'arrow', from: { x: 100, y: 50 }, to: { x: 20, y: 50 }, size: 'l', color: 'red' };
    expect(hitTestMarks([arrow], { x: 43, y: 61 })).toBe(arrow);
    const { bounds } = getMarkGeometry(arrow);
    expect(bounds.y).toBeLessThanOrEqual(38);
    expect(bounds.y + bounds.height).toBeGreaterThanOrEqual(62);
    expect(hitTestMarks([arrow], { x: 43, y: 61 }, 1, undefined, { crop: { x: 50, y: 0, width: 50, height: 100 } })).toBeNull();
  });
  it('selects the topmost painted mark rather than empty corners and freehand bounding boxes', () => {
    const ellipse: ImageMarkV1 = { id: 'ellipse', kind: 'ellipse', rect: { x: 0, y: 0, width: 100, height: 100 }, size: 's', color: 'blue' };
    const line: ImageMarkV1 = { id: 'line', kind: 'freehand', points: [{ x: 0, y: 0 }, { x: 100, y: 100 }], size: 's', color: 'red' };
    expect(hitTestMarks([ellipse, line], { x: 50, y: 50 })).toBe(line);
    expect(hitTestMarks([ellipse, line], { x: 95, y: 5 })).toBeNull();
    expect(hitTestMarks([ellipse, line], { x: 90, y: 50 })).toBe(ellipse);
  });
  it('uses the incremental midpoint path unchanged at export and gives highlighter multiply geometry', () => {
    const points = [{ x: 0, y: 0 }, { x: 20, y: 30 }, { x: 40, y: 20 }];
    expect(freehandPath(points)).toBe(`M0 0${appendFreehandSegment(points[0]!, points[1]!)}${appendFreehandSegment(points[1]!, points[2]!)}L40 20`);
    const mark: ImageMarkV1 = { id: 'h', kind: 'highlighter', points, size: 'm', color: 'yellow' };
    expect(getMarkGeometry(mark).paths[0]).toMatchObject({ d: freehandPath(points), blendMode: 'multiply', opacity: 0.35, strokeWidth: 20 });
  });
  it('fits an applied crop into the unchanged box, centred, with the clip on the crop', () => {
    const view = resolveCropView({ x: 500, y: 100, width: 500, height: 100 }, { width: 1000, height: 400 }, { width: 500, height: 200 });
    expect(view.scale).toBe(2);
    expect(view.clip).toEqual({ top: 50, left: 250, bottom: 100, right: 0 });
    const left = view.x + view.clip.left * view.scale, right = left + 250 * view.scale;
    const top = view.y + view.clip.top * view.scale, bottom = top + 50 * view.scale;
    expect([left, 500 - right]).toEqual([0, 0]);
    expect(top).toBe(200 - bottom);
  });
  it('keeps crop corner arms inside a small crop', () => {
    expect(cropOverlayPaths({ x: 0, y: 0, width: 10, height: 10 }, { width: 100, height: 100 }, 22).corners).toContain('V5');
  });
  it('hit-tests the smoothed curve rather than the unsmoothed control polygon', () => {
    const mark: ImageMarkV1 = { id: 'curve', kind: 'freehand', points: [{ x: 0, y: 100 }, { x: 100, y: 0 }, { x: 200, y: 100 }], color: 'red', size: 's' };
    expect(hitTestMarks([mark], { x: 100, y: 25 })).toBe(mark);
    expect(hitTestMarks([mark], { x: 100, y: 0 })).toBeNull();
  });
});
