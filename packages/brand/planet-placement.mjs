// Canonical Home placement and scene inputs extracted from homePlanetPlacement.ts.
const CORNER_ROTATE = -1.5, SIDE_ROTATE = -1, RISE_ROTATE = -1.5;
const TAIL = 1.6, FALL = 0.8, START = 0.3, RAMP = 0.6, OVER = 0.62;
const INK = { light: 1.15, dark: 0.8 };
const RISE_LIMB_FALLBACK = { phone: 0.34, desktop: 0.49 };
function homePlanetGeometry(placement, pane, options = {}) {
  const W = pane.width, H = pane.height;
  if (placement === "rise") {
    // A profile band keeps its planet round (R from its column), where Home's Rise spans its pane.
    const R2 = options.radius ?? (options.phone ? 1.3 : 0.8) * W;
    const limb = options.limb ?? (options.phone ? RISE_LIMB_FALLBACK.phone : RISE_LIMB_FALLBACK.desktop) * H;
    return {
      R: R2,
      cx: 0.5 * W,
      cy: limb + R2,
      rotate: RISE_ROTATE,
      fullness: 1,
      halo: { top: 0, left: 0.7, right: 0.7, bottom: 1 },
      tail: TAIL,
      fall: FALL,
      reach: { top: 1.03, left: 2.1, right: 2.1, bottom: 1.2 },
      around: 1
    };
  }
  const noWidgets = options.widgets === false;
  if (options.phone) {
    if (placement === "side") {
      const R3 = (noWidgets ? 0.5 : 0.36) * W;
      return {
        R: R3,
        cx: W + 0.3 * R3,
        cy: (noWidgets ? 0.6 : 0.13) * H,
        rotate: SIDE_ROTATE,
        fullness: 1,
        halo: { top: 1.2, left: 0.7, bottom: noWidgets ? 1.2 : 0.5, right: 1 },
        tail: TAIL,
        fall: FALL,
        reach: { top: 3.2, right: 3.2, left: 2.2, bottom: noWidgets ? 3 : 2 }
      };
    }
    const R2 = 0.38 * W;
    return {
      R: R2,
      cx: W - 0.36 * R2,
      cy: 0.38 * R2,
      rotate: CORNER_ROTATE,
      fullness: 1,
      halo: { top: 1, right: 1, left: 1, bottom: 0.6 },
      tail: TAIL,
      fall: FALL,
      reach: { top: 3.2, right: 3.2, left: 2.7, bottom: 1.9 }
    };
  }
  if (placement === "side") {
    const R2 = (noWidgets ? 0.38 : 0.3) * H;
    return {
      R: R2,
      cx: W + (noWidgets ? 0.5 : 0.4) * R2,
      cy: (noWidgets ? 0.5 : 0.33) * H,
      rotate: SIDE_ROTATE,
      fullness: 1,
      halo: { top: 1.4, left: 0.8, bottom: noWidgets ? 1.4 : 0.8, right: 1 },
      tail: TAIL,
      fall: FALL,
      reach: { top: 3.2, right: 3.2, left: 2.5, bottom: noWidgets ? 3.2 : 2.5 }
    };
  }
  const R = 0.34 * H;
  return {
    R,
    cx: W - 0.25 * R,
    cy: 0.5 * R,
    rotate: CORNER_ROTATE,
    fullness: 1,
    halo: { top: 1, right: 1, left: 1, bottom: 0.8 },
    tail: TAIL,
    fall: FALL,
    reach: { top: 3.2, right: 3.2, left: 2.7, bottom: 2.7 }
  };
}
function homePlanetSceneOptions(geometry, pane, look) {
  return {
    theme: look.theme,
    R: geometry.R,
    cx: geometry.cx,
    cy: geometry.cy,
    view: { w: pane.width, h: pane.height },
    time: 0,
    rate: 0,
    rotate: geometry.rotate,
    mirror: false,
    fullness: geometry.fullness,
    halo: geometry.halo,
    tail: geometry.tail,
    style: look.style,
    field: look.digits ? {
      around: geometry.around ?? 1,
      reach: geometry.reach,
      fall: geometry.fall,
      ink: INK[look.theme],
      start: START,
      ramp: RAMP,
      over: OVER,
      overStyle: "ink"
    } : { around: 0, over: 0 }
  };
}
export {
  homePlanetGeometry,
  homePlanetSceneOptions
};
