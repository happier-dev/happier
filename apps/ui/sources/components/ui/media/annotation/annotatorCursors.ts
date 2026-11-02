import type { ImageMarkColorV1, ImageMarkSizeV1 } from '@happier-dev/protocol';

import type { AnnotatorTool } from './types';
import { MARK_COLORS, MARK_STROKE } from './markGeometry';

const SYSTEM_CURSOR: Readonly<Record<AnnotatorTool, string>> = {
  select: 'default',
  arrow: 'crosshair',
  rectangle: 'crosshair',
  ellipse: 'crosshair',
  freehand: 'crosshair',
  highlighter: 'crosshair',
  text: 'text',
  step: 'none',
  blur: 'crosshair',
  crop: 'crosshair',
  element: 'crosshair',
};

function svgCursor(markup: string, width: number, height: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${markup}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${Math.round(width / 2)} ${Math.round(height / 2)}, crosshair`;
}

/**
 * The cursor is the tool (MIS §3.1, §12d): Draw is a ring the size of its stroke in the mark's colour,
 * Highlighter a bar as tall as its stroke. Each stands on a white halo so it reads on any picture. The
 * step's ghost is drawn in the canvas, so the pointer itself goes away there. `pointsToScreen` converts
 * the stroke to the picture's size on screen.
 */
export function resolveToolCursor(
  tool: AnnotatorTool,
  style: Readonly<{ color: ImageMarkColorV1; size: ImageMarkSizeV1 }>,
  pointsToScreen: number,
): string {
  const stroke = Math.max(4, Math.round(MARK_STROKE[style.size] * pointsToScreen));
  const color = MARK_COLORS[style.color];
  if (tool === 'freehand') {
    const box = stroke + 6;
    const middle = box / 2;
    return svgCursor(
      `<circle cx="${middle}" cy="${middle}" r="${stroke / 2 + 1.5}" fill="none" stroke="#fff" stroke-width="1"/>`
      + `<circle cx="${middle}" cy="${middle}" r="${stroke / 2}" fill="none" stroke="${color}" stroke-width="1.5"/>`,
      box, box,
    );
  }
  if (tool === 'highlighter') {
    const tall = stroke * 4;
    return svgCursor(
      `<rect x="1" y="1" width="6" height="${tall}" rx="2" fill="#fff"/><rect x="2" y="2" width="4" height="${tall - 2}" rx="1" fill="${color}"/>`,
      8, tall + 2,
    );
  }
  return SYSTEM_CURSOR[tool];
}
