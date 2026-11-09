import { resolveFloatingFrameChromeHeight } from '@happier-dev/plugin-ui/presentation';

/** The viewer's gutter from the area's edges (the floating presences' 16). */
export const SESSION_VIEWER_EDGE = 16;
/**
 * The first floating width, as a share of the measured area: a presentation default the person
 * resizes, not a ceiling. The lab's 420 of a ~1000 reading area.
 */
export const DEFAULT_WIDTH_SHARE = 0.42;
/** The live picture's aspect until the source reports its own. */
export const SESSION_VIEWER_DEFAULT_ASPECT = 16 / 10;
/**
 * The least body height a state card (unavailable, recovery, opening) needs in the frame: its glyph,
 * a two-line title, three lines of reason, one action and the Details disclosure inside the card's own
 * padding. Below it the card is clipped by the body's rounded edge.
 */
export const SESSION_VIEWER_STATE_MIN_BODY = 272;
/**
 * The body height the Computer permission card needs in the frame (QA-COMP2 OG-1): its heading,
 * the two sentences, both grants, Open privacy settings and Check again, measured at the default
 * floating widths. The source asks for it only while that card is its picture; the frame never
 * outgrows its area, and a shorter body scrolls the card from its top.
 */
export const SESSION_VIEWER_PERMISSION_MIN_BODY = 480;
/**
 * The room a phone viewer holds above the composer in Chat, docked or expanded: a frame whose body
 * holds a state card, inside its gutters. The composer's attention band yields this much, so a tall
 * band never covers the dock nor squeezes Expanded below the dock it came from.
 */
export const SESSION_VIEWER_PHONE_RESERVE =
  resolveFloatingFrameChromeHeight({ footer: false }) + SESSION_VIEWER_STATE_MIN_BODY + SESSION_VIEWER_EDGE * 2;

/**
 * The shape of the frame's body at `width`. The source's own picture shape wins; until it reports one
 * the body is a stand-in for the picture, 16:10 unless that is too short to hold a state card, in
 * which case it is as tall as the card needs (`minBody`: the least a state card needs, or what the source
 * asked for while its state is taller). Frames wider than the card's height × 16:10 never change.
 */
export function resolveSessionViewerBodyAspect(
  reported: number | null | undefined,
  width: number,
  minBody: number = SESSION_VIEWER_STATE_MIN_BODY,
): number {
  if (reported != null && reported > 0 && Number.isFinite(reported)) return reported;
  if (!(width > 0)) return SESSION_VIEWER_DEFAULT_ASPECT;
  return width / Math.max(width / SESSION_VIEWER_DEFAULT_ASPECT, minBody);
}
