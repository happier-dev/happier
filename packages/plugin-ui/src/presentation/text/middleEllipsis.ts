/**
 * Where a one-line middle ellipsis keeps the end: a path's last segment, a name's disambiguating suffix
 * ("devbox · 3ad2"), otherwise the last two fifths. The web draws only a tail ellipsis, so a middle one is
 * two runs: the head shrinks with its own ellipsis and this tail stays whole. The tail is a run of its own
 * and a browser drops a space at the start of a run, so a suffix keeps its " · " through a no-break space.
 *
 * A path whose last segment is short beside it (under a quarter: "…/claude", "…/codex") is told apart from its
 * siblings by its parents, so it keeps its root whole ("/tmp", "~/.gemini") and the rest, drawn right to left
 * between bidi marks, gives up its start behind one ellipsis: "/tmp…20261030/claude" (sweep #18).
 */
export function splitForWebMiddleEllipsis(value: string): Readonly<{ head: string; tail: string; headStyle: MiddleEllipsisHeadStyle; tailStyle: MiddleEllipsisTailStyle }> | null {
  const split = splitAtMiddle(value);
  // A word space at either edge of a run is dropped by the browser ("POST/checkout", "youcan’t"): it stays, unbreakable.
  return split && { ...split, head: split.head.replace(/ $/u, '\u00a0'), tail: split.tail.replace(/^(\u200e?) /u, '$1\u00a0') };
}

function splitAtMiddle(value: string): Readonly<{ head: string; tail: string; headStyle: MiddleEllipsisHeadStyle; tailStyle: MiddleEllipsisTailStyle }> | null {
  const slash = value.lastIndexOf('/');
  if (slash > 0 && slash < value.length - 1) {
    const root = value.indexOf('/', value.startsWith('/') ? 1 : value.indexOf('/') + 1);
    // A file name or a long folder name keeps the old promise (the end stays whole at any width).
    if ((value.length - slash) * 4 >= value.length || root <= 0 || root >= slash)
      return { head: value.slice(0, slash), tail: value.slice(slash), headStyle: HEAD, tailStyle: TAIL };
    return { head: value.slice(0, root), tail: `\u200e${value.slice(root)}\u200e`, headStyle: HEAD_WHOLE, tailStyle: TAIL_FROM_START };
  }
  const suffix = value.lastIndexOf(' · ');
  if (suffix > 0 && suffix < value.length - 3) return { head: value.slice(0, suffix), tail: `\u00a0${value.slice(suffix + 1)}`, headStyle: HEAD, tailStyle: TAIL };
  if (value.length < 8) return null;
  const cut = Math.ceil(value.length * 0.6);
  return { head: value.slice(0, cut), tail: value.slice(cut), headStyle: HEAD, tailStyle: TAIL };
}

const HEAD = Object.freeze({ flexShrink: 1, minWidth: 0 } as const);
/** A path's root beside a tail that gives up its start: it stays whole. */
const HEAD_WHOLE = Object.freeze({ flexShrink: 0 } as const);
const TAIL = Object.freeze({ flexShrink: 0 } as const);
/** The rest of a path after its root: drawn right to left, its one-line ellipsis falls at its start and its end stays. */
const TAIL_FROM_START = Object.freeze({ flexShrink: 1, minWidth: 0, writingDirection: 'rtl' } as const);
type MiddleEllipsisHeadStyle = typeof HEAD | typeof HEAD_WHOLE;
type MiddleEllipsisTailStyle = typeof TAIL | typeof TAIL_FROM_START;

/** The two runs' layout on the web: the head shrinks and the tail keeps its width, or a path's root stays and the rest shrinks from its start. */
export const HAPPIER_MIDDLE_ELLIPSIS_STYLE = Object.freeze({
  row: Object.freeze({ display: 'flex', flexDirection: 'row', overflow: 'hidden', minWidth: 0 } as const),
  head: HEAD,
  headWhole: HEAD_WHOLE,
  tail: TAIL,
  tailFromStart: TAIL_FROM_START,
});
