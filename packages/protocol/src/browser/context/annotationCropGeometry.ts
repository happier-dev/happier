/**
 * Canonical annotation crop geometry for browser context capture.
 *
 * Coordinate contract:
 * - Editor geometry is recorded in CSS viewport coordinates.
 * - Full-page producers convert viewport coordinates to page coordinates with scrollX/scrollY.
 * - CDP consumes CSS page coordinates with `scale = devicePixelRatio`.
 * - Wry consumes device-pixel page coordinates directly.
 */

export type AnnotationViewportRect = Readonly<{
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type AnnotationStrokePointViewport = Readonly<{ x: number; y: number }>;

export type AnnotationCropSurfaceBounds = Readonly<{ width: number; height: number }>;

export type AnnotationCropViewportInput = Readonly<{
  scrollX: number;
  scrollY: number;
  devicePixelRatio: number;
  /** Device-pixel bounds of the captured surface. */
  surface: AnnotationCropSurfaceBounds;
}>;

export type ResolveAnnotationCropClipInput = Readonly<{
  /** Element + region rects, CSS viewport px. */
  targets: readonly AnnotationViewportRect[];
  /** Freehand/vector stroke point sequences in CSS viewport px. */
  strokes?: readonly (readonly AnnotationStrokePointViewport[])[];
  viewport: AnnotationCropViewportInput;
}>;

export type AnnotationCropClip = Readonly<{
  status: 'clip';
  /** CSS-pixel viewport-space rect: editor/native overlay coordinates. */
  cssViewportRect: AnnotationViewportRect;
  /** CSS-pixel page-space rect: CDP `clip` coordinates. */
  cssPageRect: AnnotationViewportRect;
  /** Device-pixel page-space rect: Wry physical-buffer coordinates. */
  devicePageRect: AnnotationViewportRect;
  scale: number;
}>;

export type AnnotationCropClipResult = AnnotationCropClip | Readonly<{ status: 'empty' }>;

function hasArea(rect: AnnotationViewportRect): boolean {
  return Number.isFinite(rect.width) && Number.isFinite(rect.height) && rect.width > 0 && rect.height > 0;
}

export function unionViewportRects(
  rects: readonly AnnotationViewportRect[],
): AnnotationViewportRect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let found = false;
  for (const rect of rects) {
    if (!hasArea(rect) || !Number.isFinite(rect.x) || !Number.isFinite(rect.y)) continue;
    found = true;
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  if (!found) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function strokeViewportBounds(
  points: readonly AnnotationStrokePointViewport[],
): AnnotationViewportRect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let found = false;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
    found = true;
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!found) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function clampRectToSurface(
  rect: AnnotationViewportRect,
  surface: AnnotationCropSurfaceBounds,
): AnnotationViewportRect {
  const x = Math.max(0, Math.min(rect.x, surface.width));
  const y = Math.max(0, Math.min(rect.y, surface.height));
  const maxX = Math.max(0, Math.min(rect.x + rect.width, surface.width));
  const maxY = Math.max(0, Math.min(rect.y + rect.height, surface.height));
  const width = Math.max(0, maxX - x);
  const height = Math.max(0, maxY - y);
  return { x, y, width, height };
}

export function resolveAnnotationCropClip(
  input: ResolveAnnotationCropClipInput,
): AnnotationCropClipResult {
  const strokeRects = (input.strokes ?? [])
    .map((points) => strokeViewportBounds(points))
    .filter((bounds): bounds is AnnotationViewportRect => bounds !== null);

  const viewportUnion = unionViewportRects([...input.targets, ...strokeRects]);
  if (!viewportUnion) return { status: 'empty' };

  const { scrollX, scrollY, devicePixelRatio, surface } = input.viewport;
  const scale = devicePixelRatio > 0 ? devicePixelRatio : 1;
  const cssPageRect: AnnotationViewportRect = {
    x: viewportUnion.x + scrollX,
    y: viewportUnion.y + scrollY,
    width: viewportUnion.width,
    height: viewportUnion.height,
  };
  const deviceRectUnclamped: AnnotationViewportRect = {
    x: cssPageRect.x * scale,
    y: cssPageRect.y * scale,
    width: cssPageRect.width * scale,
    height: cssPageRect.height * scale,
  };
  const devicePageRect = clampRectToSurface(deviceRectUnclamped, surface);

  return { status: 'clip', cssViewportRect: viewportUnion, cssPageRect, devicePageRect, scale };
}
