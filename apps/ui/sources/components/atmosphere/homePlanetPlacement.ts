import { HOME_HERO_FULL_PANE_HEIGHT } from '@happier-dev/brand/planet-placement';

export {
  HOME_HERO_FULL_PANE_HEIGHT,
  type HomePane,
} from '@happier-dev/brand/planet-placement';

/** berthd's seam: the band's height before it reaches past the composer. Phones put it at a third. */
export function homeAtmosphereSeam(paneHeight: number, phone: boolean): number {
  return phone
    ? Math.round(paneHeight / 3)
    : Math.round(Math.max(220, Math.min(HOME_HERO_FULL_PANE_HEIGHT, paneHeight) * 0.5));
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

/** The hero's foot: the band and a composer-less hero end this far under the last thing in it. */
export const HOME_HERO_FOOT_PX = 28;
export const HOME_PHONE_HERO_FOOT_PX = 20;

/**
 * The Horizon band ends a little below the composer so the whole composer sits over the picture; the
 * picture's horizon sits 72 px (phone 40 px) above the headline so the headline lands on calm sky.
 * Without a composer in the hero the band ends the same step under the headline, so the greeting is
 * the band's foot rather than a lone line in the middle of an empty picture.
 */
export function homeHorizonBand(
  input: Readonly<{
    headlineTop: number;
    headlineBottom: number;
    /** Null when the composer is not in the hero. */
    composerBottom: number | null;
    phone: boolean;
  }>,
) {
  const band = Math.round((input.composerBottom ?? input.headlineBottom) + (input.phone ? HOME_PHONE_HERO_FOOT_PX : HOME_HERO_FOOT_PX));
  const at = Math.max(
    0.3,
    Math.min(0.7, (input.headlineTop - (input.phone ? 40 : 72)) / band),
  );
  return { band, horizonAt: Number(at.toFixed(3)) };
}


/**
 * Rise's foot: the space under the hero where the planet's body fades out in order. The lab keeps "Your
 * Home" in view just above the fold, so the foot ends there; it never shortens the ordered fade (130 px
 * plus its 4 px and 6 px margins) and never grows past the lab's 200 px under the hero's own 52.
 */
const RISE_FOOT_MIN_PX = 140;
const RISE_FOOT_MAX_PX = 252;
/** From the hero's foot to the fold: the gap to the first section, its header row and about 40 px under it. */
const RISE_FOLD_RESERVE_PX = 100;
export function homeRiseFoot(input: Readonly<{ paneHeight: number; aboveBottom: number }>): number {
  return Math.round(Math.max(RISE_FOOT_MIN_PX, Math.min(RISE_FOOT_MAX_PX, input.paneHeight - input.aboveBottom - RISE_FOLD_RESERVE_PX)));
}

export function homeRiseFootFade(
  input: Readonly<{ aboveBottom: number; nextTop: number; phone: boolean }>,
) {
  const end = input.nextTop - 14;
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
