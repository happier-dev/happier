import type { HappierSurfaceGradient } from '@happier-dev/plugin-ui/presentation';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import type { UnistylesThemes } from 'react-native-unistyles';

type Theme = UnistylesThemes[keyof UnistylesThemes];

/** The edge the island stands on, or none (Floating). Native places the window; the UI draws inside it. */
export type NotchDock = 'top' | 'left' | 'right' | 'floating';

/**
 * What the island looks like, whatever presentation state put it there: the resting tip, the standard
 * island sized to its content, or the open panel. The presentation reducer decides the state; this is
 * only its visual size class.
 */
export type NotchForm = 'tip' | 'standard' | 'open';

/** Which way the open panel grows inside its window, as native's frame plan reports it (toward the display centre). */
export type NotchGrowth = Readonly<{
  x: 'left' | 'right' | null;
  y: 'up' | 'down' | null;
}>;

export type NotchSize = Readonly<{ width: number; height: number }>;

/** The hardware camera block this island wraps, when it sits in the MacBook camera notch. */
export type NotchCameraBlock = NotchSize;

export type NotchMetrics = Readonly<{
  /** The standard island's thickness across its edge (the page control height). */
  thickness: number;
  /** The open panel's width (the default dialog width). */
  openWidth: number;
  /** Concave shoulder radius where a docked island meets its edge. */
  shoulder: number;
  tipShoulder: number;
  /** Free-corner radius: standard island, open panel. */
  corner: number;
  openCorner: number;
  /** The idle tip: a short sliver of the island, its corners half its thickness. */
  tipLength: number;
  tipThickness: number;
}>;

/** Every notch dimension from its owner (lab `DECISIONS.md` "Proposed roles"); nothing here is a literal. */
export function resolveNotchMetrics(theme: Theme): NotchMetrics {
  return {
    thickness: PAGE_LIST_METRICS.controlHeightPx,
    openWidth: PAGE_LIST_METRICS.dialogWidthPx.default,
    shoulder: theme.space.s8,
    tipShoulder: theme.space.s4,
    corner: theme.borderRadius.xl,
    openCorner: theme.borderRadius.modalCard,
    tipLength: theme.space.s48,
    tipThickness: theme.space.s6,
  };
}

export function isNotchEdgeDock(
  dock: NotchDock,
): dock is 'top' | 'left' | 'right' {
  return dock !== 'floating';
}

/** Side docks stand vertically: the island's length runs down the edge. */
export function isNotchVerticalDock(dock: NotchDock): boolean {
  return dock === 'left' || dock === 'right';
}

/**
 * The body (the rounded rectangle the content lives in, shoulders excluded) for one form.
 * `content` is the standard island's measured content box, already oriented for the dock; `panel` is the
 * open panel's measured natural height, capped by `maxPanelHeight` (the window, which native clamps to
 * the visible frame).
 */
export function resolveNotchBodySize(
  params: Readonly<{
    form: NotchForm;
    dock: NotchDock;
    metrics: NotchMetrics;
    camera: NotchCameraBlock | null;
    content: NotchSize;
    panelHeight: number;
    maxPanelHeight: number | null;
  }>,
): NotchSize {
  const { metrics } = params;
  if (params.form === 'open') {
    const height =
      params.maxPanelHeight !== null && params.maxPanelHeight > 0
        ? Math.min(params.panelHeight, params.maxPanelHeight)
        : params.panelHeight;
    return { width: metrics.openWidth, height };
  }
  if (params.form === 'tip') {
    if (params.camera) {
      return params.camera;
    }
    return isNotchVerticalDock(params.dock)
      ? { width: metrics.tipThickness, height: metrics.tipLength }
      : { width: metrics.tipLength, height: metrics.tipThickness };
  }
  return params.content;
}

export function resolveNotchShoulder(
  form: NotchForm,
  dock: NotchDock,
  metrics: NotchMetrics,
): number {
  if (!isNotchEdgeDock(dock)) return 0;
  return form === 'tip' ? metrics.tipShoulder : metrics.shoulder;
}

export function resolveNotchCorner(
  form: NotchForm,
  metrics: NotchMetrics,
  body: NotchSize,
): number {
  if (form === 'tip') {
    return Math.min(body.width, body.height) / 2;
  }
  const corner = form === 'open' ? metrics.openCorner : metrics.corner;
  return Math.min(corner, Math.min(body.width, body.height) / 2);
}

/**
 * The window extent native frames: the body plus the shoulders that flare out along the edge.
 * Extent is in logical pixels; native converts it once at the display's scale.
 */
export function resolveNotchExtent(
  dock: NotchDock,
  body: NotchSize,
  shoulder: number,
): NotchSize {
  if (dock === 'top') {
    return { width: body.width + shoulder * 2, height: body.height };
  }
  if (isNotchVerticalDock(dock)) {
    return { width: body.width, height: body.height + shoulder * 2 };
  }
  return body;
}

/**
 * The concave shoulder: a quarter square with a quarter circle bitten out, so the island's fill flows
 * into the edge. Drawn in a `size × size` box whose corner `(0, 0)` touches the edge; callers place and
 * mirror it per corner.
 */
export function buildNotchShoulderPath(size: number): string {
  return `M 0 0 L ${size} 0 L ${size} ${size} A ${size} ${size} 0 0 0 0 0 Z`;
}

/** Free corners per dock: the edge side stays square and flush; Floating rounds every corner. */
export function resolveNotchCornerMask(dock: NotchDock): Readonly<{
  topLeft: boolean;
  topRight: boolean;
  bottomLeft: boolean;
  bottomRight: boolean;
}> {
  switch (dock) {
    case 'top':
      return {
        topLeft: false,
        topRight: false,
        bottomLeft: true,
        bottomRight: true,
      };
    case 'left':
      return {
        topLeft: false,
        topRight: true,
        bottomLeft: false,
        bottomRight: true,
      };
    case 'right':
      return {
        topLeft: true,
        topRight: false,
        bottomLeft: true,
        bottomRight: false,
      };
    default:
      return {
        topLeft: true,
        topRight: true,
        bottomLeft: true,
        bottomRight: true,
      };
  }
}

/**
 * Where the camera block sits under the standard island: the island's centre minus the camera block's
 * centre along the edge. Lab R2 sizes the wings to their content, so with more faces than word the
 * island leans left of the camera. Open, the panel centres on the camera block.
 */
export function resolveNotchCameraOffset(
  params: Readonly<{
    form: NotchForm;
    camera: NotchCameraBlock | null;
    leadingWing: number;
    trailingWing: number;
  }>,
): number {
  if (!params.camera || params.form !== 'standard') return 0;
  return (params.trailingWing - params.leadingWing) / 2;
}

/**
 * How far the status row moves inside the body while it stays put as the body grows around it (Top,
 * and Floating opening down; lab ntdock-G). It keeps its resting place on screen: under a body growing
 * left it moves by the growth, and on a centred body it stays on its anchor.
 */
export function resolveNotchStatusRowShift(
  params: Readonly<{
    growthX: NotchGrowth['x'];
    width: number;
    /** The open panel's settled width: the row's place is decided once against it, not per spring frame. */
    openWidth: number;
    restWidth: number;
    anchorX: number;
    centreX: number;
    /** The resting island's camera offset (`resolveNotchCameraOffset` for the standard form). */
    restCameraOffset: number;
    open: boolean;
  }>,
): number {
  'worklet';
  if (params.growthX === 'left') return params.width - params.restWidth;
  if (params.growthX !== null) return 0;
  // Resting on the camera notch, native moves the window by the camera offset so the block lands on the
  // camera; open, the window centres on the camera, so the row takes that offset to keep its faces and
  // word where they were. A wing wider than its half of the panel would be clipped there, so the row
  // stays inside the panel and moves by the difference instead.
  const cameraShift = params.open ? params.restCameraOffset : 0;
  const base = params.anchorX - params.restWidth / 2 + cameraShift - params.centreX;
  const shift = base + params.width / 2;
  if (!params.open || params.openWidth < params.restWidth) return shift;
  // Decided once against the settled panel, so the row holds still through the spring.
  const settled = base + params.openWidth / 2;
  const clamped = Math.min(Math.max(settled, 0), params.openWidth - params.restWidth);
  return shift + (clamped - settled);
}

/**
 * Where the native material stands while the island rests, in window points: the body alone. The side
 * against the screen edge runs a corner's length past the window, so only the free corners round.
 */
export function resolveNotchMaterialRect(
  dock: NotchDock,
  body: NotchSize,
  extent: NotchSize,
  shoulder: number,
  radius: number,
): Readonly<{ x: number; y: number; width: number; height: number; radius: number }> {
  switch (dock) {
    case 'top':
      return { x: shoulder, y: -radius, width: body.width, height: body.height + radius, radius };
    case 'left':
      return { x: -radius, y: shoulder, width: body.width + radius, height: body.height, radius };
    case 'right':
      return { x: extent.width - body.width, y: shoulder, width: body.width + radius, height: body.height, radius };
    case 'floating':
      return { x: 0, y: 0, width: body.width, height: body.height, radius };
  }
}

/** The dark theme's soft finish, moved to the panel's foot at its own height and ink. */
export function resolveNotchFootFinish(
  finish: HappierSurfaceGradient | null | undefined,
): (HappierSurfaceGradient & Readonly<{ band: Readonly<{ edge: 'bottom'; height: number }> }>) | null {
  if (!finish?.band) return null;
  return {
    ...finish,
    colors: [finish.colors[1], finish.colors[0]],
    band: { edge: 'bottom', height: finish.band.height },
  };
}

/**
 * The seam into the camera strip: the black row held at the hardware's height, then eased to clear over two
 * rows (smoothstep), so neither the camera block nor the row shows an edge.
 */
export function resolveNotchCameraSeamStops(rowHeight: number): Readonly<{
  height: number;
  stops: readonly Readonly<{ offset: number; alpha: number }>[];
}> {
  const height = rowHeight * 3;
  const steps = 8;
  const stops = [{ offset: 0, alpha: 1 }];
  for (let step = 0; step <= steps; step++) {
    const t = step / steps;
    stops.push({ offset: (1 + 2 * t) / 3, alpha: 1 - t * t * (3 - 2 * t) });
  }
  return { height, stops };
}
