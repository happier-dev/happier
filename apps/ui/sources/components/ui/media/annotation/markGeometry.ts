import type { ImageMarkV1, ImageMarkColorV1, ImageMarkSizeV1, ImagePointV1, ImageRectV1 } from '@happier-dev/protocol';

/** MIS §0b/§3: logical points; multiply by image.scale at the image boundary. */
export const ANNOTATOR_GEOMETRY = Object.freeze({ arrowHeadThreshold: 18, minimumArea: 8, duplicateOffset: 12, stepGhostOpacity: 0.38, stepRadius: 3, hoverOutlineOpacity: 0.22, nudge: 1, largeNudge: 10, hitPadding: 4, minimumHitTolerance: 6, handleSize: 8, handleBorder: 1.5, selectionStroke: 2, selectionGap: 2, arrowHandleRadius: 5, handleHitArea: 24, cropCornerArm: 22, cropCornerWidth: 4, cropEdgeHit: 12, cropLabelFloor: 80, thirdsOpacity: 0.35, elementStroke: 2, elementHoverStroke: 1.5, elementHoverFill: 0.14, elementTagText: 13, elementTagPaddingX: 6, elementTagPaddingY: 3, elementTooltipGap: 8 });
export const MARK_STROKE: Readonly<Record<ImageMarkSizeV1, number>> = { s: 3, m: 5, l: 8 };
/** These are content colours, identical in light/dark and in the exported image (MIS §3.3). */
export const MARK_COLORS: Readonly<Record<ImageMarkColorV1, string>> = { red: '#FF3B30', orange: '#FF9500', yellow: '#FFCC00', green: '#34C759', blue: '#0A84FF', purple: '#AF52DE', ink: '#1C1C1E' };
export type MarkPath = Readonly<{ d: string; fill?: string; stroke?: string; strokeWidth?: number; opacity?: number; blendMode?: 'multiply' }>;
export type MarkText = Readonly<{ text: string; x: number; y: number; fontSize: number; color: string; align: 'left' | 'center' }>;
export type MarkGeometry = Readonly<{ paths: readonly MarkPath[]; texts: readonly MarkText[]; bounds: ImageRectV1 }>;
export type MeasureMarkText = (text: string, fontSize: number) => number;
export const MARK_TEXT_SIZE: Readonly<Record<ImageMarkSizeV1, number>> = { s: 14, m: 18, l: 24 };
/** A text label's corner, as a share of its type size (lab `ia · I2`). */
export const MARK_LABEL_RADIUS = 0.25;

/** The eight places a selection or crop box is taken by: corners first, because they win over an edge. */
export const BOX_HANDLES = ['nw', 'ne', 'se', 'sw', 'n', 'e', 's', 'w'] as const;
export type BoxHandle = (typeof BOX_HANDLES)[number];

/** A crop's outside and its L-shaped corners, as paths in image space (D3: one geometry owner). */
export function cropOverlayPaths(crop: ImageRectV1, image: Readonly<{ width: number; height: number }>, arm: number): Readonly<{ scrim: string; corners: string; thirds: string }> {
  const { x, y, width, height } = crop;
  const right = x + width, bottom = y + height;
  const a = Math.min(arm, width / 2, height / 2);
  return {
    scrim: `M0 0H${image.width}V${image.height}H0Z${rectanglePath(crop)}`,
    corners: `M${x} ${y + a}V${y}H${x + a}M${right - a} ${y}H${right}V${y + a}M${right} ${bottom - a}V${bottom}H${right - a}M${x + a} ${bottom}H${x}V${bottom - a}`,
    thirds: [1, 2].map(n => `M${x + width * n / 3} ${y}V${bottom}M${x} ${y + height * n / 3}H${right}`).join(''),
  };
}

/** How the picture's box shows an applied crop: the crop fitted and centred in the unchanged box (MIS §3.6). */
export function resolveCropView(crop: ImageRectV1, image: Readonly<{ width: number; height: number }>, box: Readonly<{ width: number; height: number }>) {
  const fit = Math.min(image.width / crop.width, image.height / crop.height);
  const toBoxX = box.width / image.width, toBoxY = box.height / image.height;
  return {
    scale: fit,
    x: (box.width - crop.width * toBoxX * fit) / 2 - crop.x * toBoxX * fit,
    y: (box.height - crop.height * toBoxY * fit) / 2 - crop.y * toBoxY * fit,
    clip: {
      top: crop.y * toBoxY,
      left: crop.x * toBoxX,
      bottom: box.height - (crop.y + crop.height) * toBoxY,
      right: box.width - (crop.x + crop.width) * toBoxX,
    },
  };
}

export function rectFromPoints(from: ImagePointV1, to: ImagePointV1): ImageRectV1 {
  return { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x), height: Math.abs(to.y - from.y) };
}
export function rectanglePath(rect: ImageRectV1): string {
  return `M${rect.x} ${rect.y}h${rect.width}v${rect.height}h${-rect.width}Z`;
}
export function roundedRectanglePath(rect: ImageRectV1, radius: number): string {
  const r = Math.min(radius, rect.width / 2, rect.height / 2);
  const arc = (dx: number, dy: number) => `a${r} ${r} 0 0 1 ${dx} ${dy}`;
  return `M${rect.x + r} ${rect.y}h${rect.width - r * 2}${arc(r, r)}v${rect.height - r * 2}${arc(-r, r)}h${-(rect.width - r * 2)}${arc(-r, -r)}v${-(rect.height - r * 2)}${arc(r, -r)}Z`;
}
/** Incremental midpoint quadratics: the live path and export use this exact segment builder. */
export function appendFreehandSegment(previous: ImagePointV1, current: ImagePointV1): string {
  return `Q${previous.x} ${previous.y} ${(previous.x + current.x) / 2} ${(previous.y + current.y) / 2}`;
}
export function freehandPath(points: readonly ImagePointV1[]): string {
  if (!points.length) return '';
  let path = `M${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length; i++) path += appendFreehandSegment(points[i - 1]!, points[i]!);
  const last = points.at(-1)!;
  return `${path}L${last.x} ${last.y}`;
}

/** The same head vertices define paint, selection bounds and hit-testing. */
function arrowGeometry(mark: Extract<ImageMarkV1, { kind: 'arrow' }>, scale: number) {
  const dx = mark.to.x - mark.from.x, dy = mark.to.y - mark.from.y;
  const length = Math.hypot(dx, dy);
  if (!length) return null;
  const ux = dx / length, uy = dy / length;
  const strokeWidth = MARK_STROKE[mark.size] * scale;
  const head = Math.min(length, Math.max(ANNOTATOR_GEOMETRY.arrowHeadThreshold * scale, strokeWidth * 5));
  const base = { x: mark.to.x - ux * head, y: mark.to.y - uy * head };
  const left = { x: base.x - uy * head / 2, y: base.y + ux * head / 2 };
  const right = { x: base.x + uy * head / 2, y: base.y - ux * head / 2 };
  return { base, left, right, length, head };
}

export function getMarkGeometry(mark: ImageMarkV1, scale = 1, stepNumber = 1, measureText?: MeasureMarkText): MarkGeometry {
  const color = 'color' in mark ? MARK_COLORS[mark.color] : undefined;
  const strokeWidth = ('size' in mark ? MARK_STROKE[mark.size] : MARK_STROKE.m) * scale;
  const paths: MarkPath[] = [];
  const texts: MarkText[] = [];
  let bounds: ImageRectV1;
  switch (mark.kind) {
    case 'arrow': {
      bounds = rectFromPoints(mark.from, mark.to);
      const shape = arrowGeometry(mark, scale);
      if (!shape) break;
      const { base, left, right } = shape;
      bounds = boundsOfPoints([mark.from, mark.to, left, right]);
      if (shape.length > shape.head) paths.push({ d: `M${mark.from.x} ${mark.from.y}L${base.x} ${base.y}`, stroke: color, strokeWidth });
      paths.push({ d: `M${mark.to.x} ${mark.to.y}L${left.x} ${left.y}L${right.x} ${right.y}Z`, fill: color });
      break;
    }
    case 'rectangle': case 'blur': case 'element': {
      bounds = mark.rect;
      if (mark.kind === 'rectangle') paths.push({ d: rectanglePath(mark.rect), stroke: color, strokeWidth });
      if (mark.kind === 'element') {
        // The tag is a name, burned in with the box: it stands on the box, or inside it at the top of the picture.
        const edge = ANNOTATOR_GEOMETRY.elementStroke * scale;
        const fontSize = ANNOTATOR_GEOMETRY.elementTagText * scale;
        const paddingX = ANNOTATOR_GEOMETRY.elementTagPaddingX * scale, paddingY = ANNOTATOR_GEOMETRY.elementTagPaddingY * scale;
        const tag = { width: (measureText?.(mark.label, fontSize) ?? mark.label.length * fontSize * 0.55) + paddingX * 2, height: fontSize * 1.25 + paddingY * 2 };
        const above = mark.rect.y - tag.height - edge;
        const y = above >= 0 ? above : mark.rect.y + edge;
        paths.push({ d: rectanglePath(mark.rect), stroke: color, strokeWidth: edge });
        paths.push({ d: roundedRectanglePath({ x: mark.rect.x, y, ...tag }, fontSize * MARK_LABEL_RADIUS), fill: color });
        texts.push({ text: mark.label, x: mark.rect.x + paddingX, y: y + paddingY + fontSize, fontSize, color: '#ffffff', align: 'left' });
      }
      break;
    }
    case 'ellipse': {
      bounds = mark.rect;
      const { x, y, width: w, height: h } = mark.rect;
      paths.push({ d: `M${x} ${y + h / 2}a${w / 2} ${h / 2} 0 1 0 ${w} 0a${w / 2} ${h / 2} 0 1 0 ${-w} 0`, stroke: color, strokeWidth });
      break;
    }
    case 'freehand': case 'highlighter': {
      bounds = boundsOfPoints(mark.points);
      paths.push({ d: freehandPath(mark.points), stroke: color, strokeWidth: mark.kind === 'highlighter' ? strokeWidth * 4 : strokeWidth, ...(mark.kind === 'highlighter' ? { opacity: 0.35, blendMode: 'multiply' as const } : {}) });
      break;
    }
    case 'text': {
      if (!measureText) throw new Error('Text geometry requires measured text extents');
      const fontSize = MARK_TEXT_SIZE[mark.size] * scale;
      const lines = mark.text.split('\n');
      const padding = strokeWidth;
      bounds = { x: mark.at.x, y: mark.at.y, width: Math.max(...lines.map(line => measureText(line, fontSize))) + padding * 2, height: lines.length * fontSize * 1.25 + padding * 2 };
      paths.push({ d: roundedRectanglePath(bounds, fontSize * MARK_LABEL_RADIUS), fill: color });
      for (let i = 0; i < lines.length; i++) texts.push({ text: lines[i]!, x: mark.at.x + padding, y: mark.at.y + padding + fontSize + i * fontSize * 1.25, fontSize, color: '#ffffff', align: 'left' });
      break;
    }
    case 'step': {
      // A stamp's size follows its stroke (and so the picture's scale); its numeral fills the same share of it.
      const radius = strokeWidth * ANNOTATOR_GEOMETRY.stepRadius;
      bounds = { x: mark.at.x - radius, y: mark.at.y - radius, width: radius * 2, height: radius * 2 };
      paths.push({ d: `M${mark.at.x - radius} ${mark.at.y}a${radius} ${radius} 0 1 0 ${radius * 2} 0a${radius} ${radius} 0 1 0 ${-radius * 2} 0`, fill: color });
      texts.push({ text: String(stepNumber), x: mark.at.x, y: mark.at.y + radius * 0.4, fontSize: radius * 1.1, color: '#ffffff', align: 'center' });
      break;
    }
  }
  return { paths, texts, bounds: bounds! };
}

export function boundsOfPoints(points: readonly ImagePointV1[]): ImageRectV1 {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const point of points) { left = Math.min(left, point.x); top = Math.min(top, point.y); right = Math.max(right, point.x); bottom = Math.max(bottom, point.y); }
  return points.length ? { x: left, y: top, width: right - left, height: bottom - top } : { x: 0, y: 0, width: 0, height: 0 };
}

function distanceToSegment(point: ImagePointV1, from: ImagePointV1, to: ImagePointV1): number {
  const dx = to.x - from.x, dy = to.y - from.y;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared));
  return Math.hypot(point.x - from.x - t * dx, point.y - from.y - t * dy);
}

/** Stationary points of squared distance to a quadratic; endpoints are tested separately. */
function cubicRoots(a: number, b: number, c: number, d: number): readonly number[] {
  if (a === 0) {
    if (b === 0) return c === 0 ? [] : [-d / c];
    const discriminant = c * c - 4 * b * d;
    return discriminant < 0 ? [] : [(-c + Math.sqrt(discriminant)) / (2 * b), (-c - Math.sqrt(discriminant)) / (2 * b)];
  }
  const offset = b / (3 * a);
  const p = c / a - b * b / (3 * a * a);
  const q = 2 * (b / a) ** 3 / 27 - b * c / (3 * a * a) + d / a;
  const discriminant = (q / 2) ** 2 + (p / 3) ** 3;
  if (discriminant > 0) return [Math.cbrt(-q / 2 + Math.sqrt(discriminant)) + Math.cbrt(-q / 2 - Math.sqrt(discriminant)) - offset];
  if (discriminant === 0) { const root = Math.cbrt(-q / 2); return [2 * root - offset, -root - offset]; }
  const radius = 2 * Math.sqrt(-p / 3);
  const angle = Math.acos(Math.max(-1, Math.min(1, 3 * q / (p * radius)))) / 3;
  return [0, 1, 2].map(index => radius * Math.cos(angle - index * 2 * Math.PI / 3) - offset);
}

function distanceToQuadratic(point: ImagePointV1, from: ImagePointV1, control: ImagePointV1, to: ImagePointV1): number {
  const ax = from.x - 2 * control.x + to.x, ay = from.y - 2 * control.y + to.y;
  const bx = 2 * (control.x - from.x), by = 2 * (control.y - from.y);
  const cx = from.x - point.x, cy = from.y - point.y;
  const candidates = [0, 1, ...cubicRoots(2 * (ax * ax + ay * ay), 3 * (ax * bx + ay * by),
    bx * bx + by * by + 2 * (ax * cx + ay * cy), bx * cx + by * cy).filter(t => t > 0 && t < 1)];
  return Math.min(...candidates.map(t => Math.hypot(ax * t * t + bx * t + cx, ay * t * t + by * t + cy)));
}
export function hitTestMarks(marks: readonly ImageMarkV1[], point: ImagePointV1, scale = 1, measureText?: MeasureMarkText, options: Readonly<{ crop?: ImageRectV1; screenToImage?: number }> = {}): ImageMarkV1 | null {
  const crop = options.crop;
  if (crop && (point.x < crop.x || point.y < crop.y || point.x > crop.x + crop.width || point.y > crop.y + crop.height)) return null;
  for (let i = marks.length - 1; i >= 0; i--) {
    const mark = marks[i]!;
    const stroke = 'size' in mark ? MARK_STROKE[mark.size] : MARK_STROKE.m;
    const tolerance = Math.max(stroke * scale / 2 + ANNOTATOR_GEOMETRY.hitPadding * (options.screenToImage ?? scale), ANNOTATOR_GEOMETRY.minimumHitTolerance * (options.screenToImage ?? scale));
    if (mark.kind === 'arrow') {
      const shape = arrowGeometry(mark, scale);
      if (shape && (insideTriangle(point, mark.to, shape.left, shape.right) || distanceToSegment(point, mark.from, shape.base) <= tolerance
        || distanceToSegment(point, mark.to, shape.left) <= tolerance || distanceToSegment(point, mark.to, shape.right) <= tolerance)) return mark;
      continue;
    }
    if (mark.kind === 'freehand' || mark.kind === 'highlighter') {
      const radius = mark.kind === 'highlighter' ? Math.max(tolerance, stroke * scale * 2) : tolerance;
      let from = mark.points[0];
      if (!from) continue;
      for (let sample = 1; sample < mark.points.length; sample++) {
        const control = mark.points[sample - 1]!, current = mark.points[sample]!;
        const to = { x: (control.x + current.x) / 2, y: (control.y + current.y) / 2 };
        if (distanceToQuadratic(point, from, control, to) <= radius) return mark;
        from = to;
      }
      if (distanceToSegment(point, from, mark.points.at(-1)!) <= radius) return mark;
      continue;
    }
    if (mark.kind === 'ellipse') {
      const rx = mark.rect.width / 2 + tolerance, ry = mark.rect.height / 2 + tolerance;
      if (((point.x - mark.rect.x - mark.rect.width / 2) / rx) ** 2 + ((point.y - mark.rect.y - mark.rect.height / 2) / ry) ** 2 <= 1) return mark;
      continue;
    }
    const { bounds } = getMarkGeometry(mark, scale, 1, measureText);
    if (point.x >= bounds.x - tolerance && point.y >= bounds.y - tolerance && point.x <= bounds.x + bounds.width + tolerance && point.y <= bounds.y + bounds.height + tolerance) return mark;
  }
  return null;
}

function insideTriangle(p: ImagePointV1, a: ImagePointV1, b: ImagePointV1, c: ImagePointV1): boolean {
  const side = (u: ImagePointV1, v: ImagePointV1) => (p.x - v.x) * (u.y - v.y) - (u.x - v.x) * (p.y - v.y);
  const sides = [side(a, b), side(b, c), side(c, a)];
  return !sides.some(s => s < 0) || !sides.some(s => s > 0);
}
