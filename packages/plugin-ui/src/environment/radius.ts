/**
 * One radius base and the steps derived from it (DESIGN.md → "Radii derive from one base").
 *
 * It lives with the host's environment facts (beside `HappierUiTheme['radii']`, which a host projects
 * from this scale) so a host's theme can read it without loading the presentation layer.
 *
 * Small marks, controls and rows, menus, cards and sheets, and dialogs each take a step of one base
 * value, and an inner surface's radius is the outer radius minus its inset, so nested layers stay
 * concentric. A radius chosen per surface is a defect: shared metrics (field boxes, segmented tracks,
 * page sheets, collection rows, floating surfaces) read a step here, and Happier core's theme radius
 * scale is derived with the same ratios from its own base.
 *
 * - `sm`: small marks (checkboxes, chips inside a control).
 * - `md`: controls and rows (field boxes, buttons, segmented tracks, list and menu selection).
 * - `lg`: floating menus and popovers; the base itself.
 * - `xl`: cards and sheets.
 * - `xxl`: dialogs.
 */
export type HappierRadiusStep = 'sm' | 'md' | 'lg' | 'xl' | 'xxl';

export type HappierRadiusScale = Readonly<Record<HappierRadiusStep, number>>;

const HAPPIER_RADIUS_STEP_RATIOS: HappierRadiusScale = Object.freeze({
  sm: 0.6,
  md: 0.8,
  lg: 1,
  xl: 1.4,
  xxl: 1.8,
});

/** The steps of a radius scale built on `basePx`, rounded to whole points. */
export function deriveHappierRadiusScale(basePx: number): HappierRadiusScale {
  return Object.freeze({
    sm: Math.round(basePx * HAPPIER_RADIUS_STEP_RATIOS.sm),
    md: Math.round(basePx * HAPPIER_RADIUS_STEP_RATIOS.md),
    lg: Math.round(basePx * HAPPIER_RADIUS_STEP_RATIOS.lg),
    xl: Math.round(basePx * HAPPIER_RADIUS_STEP_RATIOS.xl),
    xxl: Math.round(basePx * HAPPIER_RADIUS_STEP_RATIOS.xxl),
  });
}

/** Happier's radius base. */
export const HAPPIER_RADIUS_BASE_PX = 10;

/** The default scale: sm 6 · md 8 · lg 10 · xl 14 · xxl 18. */
export const HAPPIER_RADIUS_V1: HappierRadiusScale = deriveHappierRadiusScale(HAPPIER_RADIUS_BASE_PX);

/** The radius of a surface nested `insetPx` inside one rounded at `outerPx`, so the two stay concentric. */
export function happierInnerRadius(outerPx: number, insetPx: number): number {
  return Math.max(0, outerPx - insetPx);
}
