export {
  homePlanetGeometry,
  homePlanetSceneOptions,
  type HomePlanetPlacement,
  type HomePlanetStyle,
  type HomePane,
  type HomePlanetGeometry,
} from '@happier-dev/brand/planet-placement';

/** berthd's seam: the band's height before it reaches past the composer. Phones put it at a third. */
export function homeAtmosphereSeam(paneHeight: number, phone: boolean): number {
  return phone
    ? Math.round(paneHeight / 3)
    : Math.round(Math.max(220, Math.min(500, paneHeight * 0.5)));
}

/** The headline starts this far above the seam (desktop), so the composer straddles it. */
export const HOME_HEADLINE_ABOVE_SEAM_PX = 92;
/** The phone hero opens 70 px above its seam, under the 44 px navigation row (lab `.at-phero`). */
export const HOME_PHONE_HEADLINE_ABOVE_SEAM_PX = 70;
/** The hero column's sides: it holds the page's reading column plus these (lab `.at-col`). */
export const HOME_HERO_SIDE_PX = 32;
export const HOME_PHONE_HERO_SIDE_PX = 16;
/**
 * A hero without its composer has nothing to stand on the seam (the person moved or hid it): the greeting
 * opens the page under the top chips (phone: under the 44 px navigation row), so the attention list and the
 * cards are in view instead of under a screenful of sky.
 */
const HOME_BARE_HEADLINE_TOP_PX = 72;
const HOME_PHONE_BARE_HEADLINE_TOP_PX = 60;

/** Where the hero's greeting starts in the pane. */
export function homeHeroTop(input: Readonly<{ paneHeight: number; phone: boolean; composer: boolean }>): number {
  const seamTop = Math.max(
    16,
    homeAtmosphereSeam(input.paneHeight, input.phone)
      - (input.phone ? HOME_PHONE_HEADLINE_ABOVE_SEAM_PX : HOME_HEADLINE_ABOVE_SEAM_PX),
  );
  if (input.composer) return seamTop;
  return Math.min(seamTop, input.phone ? HOME_PHONE_BARE_HEADLINE_TOP_PX : HOME_BARE_HEADLINE_TOP_PX);
}

/** The composer stands this far under the headline. */
export const HOME_HERO_COMPOSER_GAP_PX = 18;
export const HOME_PHONE_HERO_COMPOSER_GAP_PX = 14;

/**
 * The Horizon band ends a little below the composer so the whole composer sits over the picture; the
 * picture's horizon sits 72 px (phone 40 px) above the headline so the headline lands on calm sky.
 */
export function homeHorizonBand(
  input: Readonly<{
    headlineTop: number;
    /** Null when the composer is not in the hero: the band then ends at the seam. */
    composerBottom: number | null;
    seam: number;
    phone: boolean;
  }>,
) {
  const band = input.composerBottom === null ? input.seam : Math.round(input.composerBottom + (input.phone ? 20 : 28));
  const at = Math.max(
    0.3,
    Math.min(0.7, (input.headlineTop - (input.phone ? 40 : 72)) / band),
  );
  return { band, horizonAt: Number(at.toFixed(3)) };
}

/** The Horizon dissolve runs from 58 % of the band to its foot, thinning through the composer. */
import { ATMOSPHERE_HORIZON_FADE_FROM as HOME_HORIZON_FADE_FROM } from '@happier-dev/brand/atmosphere';
export { HOME_HORIZON_FADE_FROM };

/**
 * A Project's planet lives in its band (plan R-7): drawn only above the bottom of the Project tabs and
 * ending there in the ordered foot fade, so the page under the tabs keeps its own ground. Rise's limb
 * sits high in the band so its crown shows behind the header instead of falling below the tabs.
 */
export function projectPlanetBand(band: number) {
  return {
    fade: { from: Math.round(band * HOME_HORIZON_FADE_FROM), to: band },
    riseLimb: Math.round(band * 0.4),
  };
}

/** Rise: the limb crosses the composer's top; its body leaves in order before the widgets. */
export function homeRiseLimb(composerTop: number): number {
  return composerTop + 10;
}
export function homeRiseFootFade(
  input: Readonly<{ aboveBottom: number; nextTop: number; phone: boolean }>,
) {
  const end = input.nextTop - 6;
  return {
    from: Math.max(input.aboveBottom + 4, end - (input.phone ? 90 : 130)),
    to: end,
  };
}

/**
 * How far down Home's planet is drawn: the pane, or for Rise with a foot fade the end of that fade, so
 * the body always ends in its own ordered fade in page space (it scrolls with the content) however tall
 * the hero grows.
 */
export function homePlanetDrawnHeight(
  paneHeight: number,
  fade: Readonly<{ to: number }> | undefined,
): number {
  return fade ? Math.max(paneHeight, Math.ceil(fade.to)) : paneHeight;
}
