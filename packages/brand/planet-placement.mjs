// Canonical Home placement and scene inputs extracted from homePlanetPlacement.ts.
const CORNER_ROTATE = -1.5, SIDE_ROTATE = -1, RISE_ROTATE = -1.5;
const TAIL = 1.6, FALL = 0.8, START = 0.3, RAMP = 0.6, OVER = 0.62;
const INK = { light: 1.15, dark: 0.8 };
const RISE_LIMB_FALLBACK = { phone: 0.34, desktop: 0.49 };
// Home's hero stops growing at this pane height. Corner and Side stop with it: on a taller window the
// planet stays an object beside the hero, rather than growing behind the greeting and the rows under it.
const HOME_HERO_FULL_PANE_HEIGHT = 1000;
function homePlanetGeometry(placement, pane, options = {}) {
  const W = pane.width, H = Math.min(pane.height, HOME_HERO_FULL_PANE_HEIGHT);
  if (placement === "rise") {
    // A profile band keeps its planet round (R from its column), where Home's Rise spans its pane.
    const R2 = options.radius ?? (options.phone ? 1.3 : 0.8) * W;
    const limb = options.limb ?? (options.phone ? RISE_LIMB_FALLBACK.phone : RISE_LIMB_FALLBACK.desktop) * pane.height;
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
        cy: noWidgets ? 0.6 * pane.height : 0.13 * H,
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
      cy: noWidgets ? 0.5 * pane.height : 0.33 * H,
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
  HOME_HERO_FULL_PANE_HEIGHT,
  homePlanetGeometry,
  homePlanetSceneOptions
};

const HORIZON_HALO = { top: 0, left: 0.7, right: 0.7, bottom: 1 };
const WELCOME_HALO = { ...HORIZON_HALO, top: 0.35 };
const WELCOME_POSES = {
  welcome: [0.72, 0.665, 0],
  welcomeDim: [0.72, 0.665, 0],
  deep: [0.84, 0.76, 0.35],
  deeper: [0.88, 0.8, 0.7],
  night: [0.8, 0.72, 0.5],
  place: [0.72, 0.665, 2.1],
  placeDeep: [0.84, 0.76, 2.45],
  team: [0.74, 0.68, -0.9],
  sheet: [0.84, 0.76, 0.35],
};

export function horizonPlanetGeometry(pane, { phone = false, composerTop, limb, radius } = {}) {
  const R = radius ?? (phone ? 0.92 * pane.width : Math.min(1300, 0.6 * pane.width));
  const horizon = limb ?? (composerTop !== undefined ? composerTop + 10 : pane.height * (phone ? 0.34 : 0.49));
  return { R, cx: pane.width / 2, cy: horizon + R, rotate: -1.5, halo: HORIZON_HALO, limb: horizon };
}

export function welcomePlanetPose(state, pane, { phone = false } = {}) {
  const [phoneLimb, desktopLimb, spin] = WELCOME_POSES[state];
  const R = phone ? 0.95 * pane.width : Math.min(0.42 * pane.width, 0.7 * pane.height);
  const limb = pane.height * (phone ? phoneLimb : desktopLimb);
  return {
    R, cx: pane.width / 2, cy: limb + R, rotate: -1.5, halo: WELCOME_HALO, limb, spin: 1.65 + spin,
    ...(state === 'welcomeDim' && { dim: 0.45, reveal: 0.55 }),
    ...(state === 'sheet' && { dim: 0.55 }),
    ...(state === 'night' && { reveal: 0.14, glow: 1.25 }),
    ...(state === 'team' && { light: [0.62, -0.55, 0.56].map(value => value / Math.hypot(0.62, -0.55, 0.56)) }),
  };
}
