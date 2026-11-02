import type { ImageMarkV1, ImagePointV1, ImageRectV1 } from '@happier-dev/protocol';
import { ANNOTATOR_GEOMETRY, getMarkGeometry, MARK_STROKE, MARK_TEXT_SIZE, type MeasureMarkText } from './markGeometry';
import type { AnnotatorTool } from './types';

export type MarkHandle = 'from' | 'to' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
export type SelectionHandle = Readonly<{ kind: MarkHandle; at: ImagePointV1 }>;

export function constrainPoint(tool: AnnotatorTool | 'move', from: ImagePointV1, to: ImagePointV1): ImagePointV1 {
  const dx = to.x - from.x, dy = to.y - from.y;
  if (tool === 'rectangle' || tool === 'ellipse' || tool === 'crop') {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: from.x + (dx < 0 ? -side : side), y: from.y + (dy < 0 ? -side : side) };
  }
  if (tool === 'arrow') {
    const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
    const length = Math.hypot(dx, dy);
    return { x: from.x + Math.cos(angle) * length, y: from.y + Math.sin(angle) * length };
  }
  return Math.abs(dx) >= Math.abs(dy) ? { x: to.x, y: from.y } : { x: from.x, y: to.y };
}

export function translateMark(mark: ImageMarkV1, dx: number, dy: number): ImageMarkV1 {
  const move = (point: ImagePointV1) => ({ x: point.x + dx, y: point.y + dy });
  switch (mark.kind) {
    case 'arrow': return { ...mark, from: move(mark.from), to: move(mark.to) };
    case 'rectangle': case 'ellipse': case 'blur': return { ...mark, rect: { ...mark.rect, ...move(mark.rect) } };
    case 'freehand': case 'highlighter': return { ...mark, points: mark.points.map(move) };
    case 'text': case 'step': return { ...mark, at: move(mark.at) };
    case 'element': return mark;
  }
}

export function selectionHandles(mark: ImageMarkV1, scale = 1, measureText?: MeasureMarkText): readonly SelectionHandle[] {
  if (mark.kind === 'element') return [];
  if (mark.kind === 'arrow') return [{ kind: 'from', at: mark.from }, { kind: 'to', at: mark.to }];
  const { x, y, width, height } = getMarkGeometry(mark, scale, 1, measureText).bounds;
  const corners: SelectionHandle[] = [{ kind: 'nw', at: { x, y } }, { kind: 'ne', at: { x: x + width, y } },
    { kind: 'se', at: { x: x + width, y: y + height } }, { kind: 'sw', at: { x, y: y + height } }];
  return mark.kind === 'freehand' ? corners : [...corners,
    { kind: 'n', at: { x: x + width / 2, y } }, { kind: 'e', at: { x: x + width, y: y + height / 2 } },
    { kind: 's', at: { x: x + width / 2, y: y + height } }, { kind: 'w', at: { x, y: y + height / 2 } }];
}

/** The selection ring's halo and its handles' face. */
export const SELECTION_HALO = '#FFFFFF';

/**
 * The selection's frame sits a gap outside the mark's paint; `unit` is image pixels per screen pixel. The ring
 * is drawn two-tone (a white halo filling that gap, the focus line on it), so it reads on every swatch, a blue
 * mark included. The halo is picture content like the marks, so it is white in both themes.
 */
export function selectionPad(mark: ImageMarkV1, scale: number, unit: number): number {
  const stroke = 'size' in mark ? MARK_STROKE[mark.size] : MARK_STROKE.m;
  return (mark.kind === 'text' || mark.kind === 'blur' ? 0 : (stroke * scale) / 2) + ANNOTATOR_GEOMETRY.selectionGap * unit;
}

export function selectionFrame(mark: ImageMarkV1, scale: number, unit: number, measureText?: MeasureMarkText): ImageRectV1 {
  const bounds = getMarkGeometry(mark, scale, 1, measureText).bounds;
  const pad = selectionPad(mark, scale, unit);
  return { x: bounds.x - pad, y: bounds.y - pad, width: bounds.width + pad * 2, height: bounds.height + pad * 2 };
}

/** The handles as drawn: on the frame's corners and edges, an arrow's on its two ends. */
export function framedSelectionHandles(mark: ImageMarkV1, scale: number, unit: number, measureText?: MeasureMarkText): readonly SelectionHandle[] {
  const handles = selectionHandles(mark, scale, measureText);
  if (mark.kind === 'arrow') return handles;
  const pad = selectionPad(mark, scale, unit);
  return handles.map(({ kind, at }) => ({ kind, at: {
    x: at.x + (kind.includes('w') ? -pad : kind.includes('e') ? pad : 0),
    y: at.y + (kind.includes('n') ? -pad : kind.includes('s') ? pad : 0),
  } }));
}

export function resizeRect(rect: ImageRectV1, handle: MarkHandle, point: ImagePointV1): ImageRectV1 {
  let x = rect.x, y = rect.y, right = rect.x + rect.width, bottom = rect.y + rect.height;
  if (handle.includes('w')) x = point.x;
  if (handle.includes('e')) right = point.x;
  if (handle.includes('n')) y = point.y;
  if (handle.includes('s')) bottom = point.y;
  return { x: Math.min(x, right), y: Math.min(y, bottom), width: Math.abs(right - x), height: Math.abs(bottom - y) };
}

export function resizeMark(mark: ImageMarkV1, handle: MarkHandle, point: ImagePointV1, scale = 1, measureText?: MeasureMarkText): ImageMarkV1 {
  if (mark.kind === 'element') return mark;
  if (mark.kind === 'arrow') return handle === 'from' || handle === 'to' ? { ...mark, [handle]: point } : mark;
  const bounds = getMarkGeometry(mark, scale, 1, measureText).bounds;
  const rect = resizeRect(bounds, handle, point);
  // A zero-area preview is allowed, but cannot replace the admitted mark on release.
  if (!rect.width || !rect.height) return mark;
  if (mark.kind === 'rectangle' || mark.kind === 'ellipse' || mark.kind === 'blur') return { ...mark, rect };
  const map = (at: ImagePointV1) => ({ x: rect.x + (bounds.width ? (at.x - bounds.x) / bounds.width : 0) * rect.width,
    y: rect.y + (bounds.height ? (at.y - bounds.y) / bounds.height : 0) * rect.height });
  if (mark.kind === 'freehand' || mark.kind === 'highlighter') return { ...mark, points: mark.points.map(map) };
  const sizes = mark.kind === 'text' ? MARK_TEXT_SIZE : MARK_STROKE;
  const target = sizes[mark.size] * (bounds.height ? rect.height / bounds.height : 1);
  const size = (['s', 'm', 'l'] as const).reduce((best, candidate) => Math.abs(sizes[candidate] - target) < Math.abs(sizes[best] - target) ? candidate : best, mark.size);
  return { ...mark, at: map(mark.at), size };
}

/**
 * A handle follows the pointer's travel from where it was pressed, not the pointer itself, so pressing a
 * handle anywhere in its hit area without moving changes nothing. Shift squares a box from its opposite
 * corner and snaps an arrow end to 45° around the other end (MIS §3.1).
 */
export function dragHandle(mark: ImageMarkV1, handle: MarkHandle, from: ImagePointV1, point: ImagePointV1,
  options: Readonly<{ shift?: boolean; scale?: number; measureText?: MeasureMarkText }> = {}): ImageMarkV1 {
  const { scale = 1, measureText } = options;
  const at = selectionHandles(mark, scale, measureText).find((entry) => entry.kind === handle)?.at;
  if (!at || (point.x === from.x && point.y === from.y)) return mark;
  let target = { x: at.x + point.x - from.x, y: at.y + point.y - from.y };
  if (options.shift && mark.kind === 'arrow') target = constrainPoint('arrow', handle === 'from' ? mark.to : mark.from, target);
  else if (options.shift && (mark.kind === 'rectangle' || mark.kind === 'ellipse' || mark.kind === 'blur') && handle.length === 2) {
    const { x, y, width, height } = mark.rect;
    target = constrainPoint('rectangle', { x: handle.includes('w') ? x + width : x, y: handle.includes('n') ? y + height : y }, target);
  }
  return resizeMark(mark, handle, target, scale, measureText);
}
