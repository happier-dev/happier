// The pane height where Home's hero stops growing.
export const HOME_HERO_FULL_PANE_HEIGHT = 1000;

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
