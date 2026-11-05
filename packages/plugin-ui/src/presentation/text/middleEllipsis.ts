/**
 * Where a one-line middle ellipsis keeps the end: a path's last segment, a name's disambiguating suffix
 * ("devbox · 3ad2"), otherwise the last two fifths. The web draws only a tail ellipsis, so a middle one is
 * two runs: the head shrinks with its own ellipsis and this tail stays whole. The tail is a run of its own
 * and a browser drops a space at the start of a run, so a suffix keeps its " · " through a no-break space.
 */
export function splitForWebMiddleEllipsis(value: string): Readonly<{ head: string; tail: string }> | null {
  const slash = value.lastIndexOf('/');
  if (slash > 0 && slash < value.length - 1) return { head: value.slice(0, slash), tail: value.slice(slash) };
  const suffix = value.lastIndexOf(' · ');
  if (suffix > 0 && suffix < value.length - 3) return { head: value.slice(0, suffix), tail: ` ${value.slice(suffix + 1)}` };
  if (value.length < 8) return null;
  const cut = Math.ceil(value.length * 0.6);
  // A word space at the cut would be dropped at the edge of its run ("youcan’t"): it stays, unbreakable.
  return { head: value.slice(0, cut).replace(/ $/u, '\u00a0'), tail: value.slice(cut).replace(/^ /u, '\u00a0') };
}

/** The two runs' layout on the web: the head shrinks, the tail keeps its width. */
export const HAPPIER_MIDDLE_ELLIPSIS_STYLE = Object.freeze({
  row: Object.freeze({ display: 'flex', flexDirection: 'row', overflow: 'hidden', minWidth: 0 } as const),
  head: Object.freeze({ flexShrink: 1, minWidth: 0 } as const),
  tail: Object.freeze({ flexShrink: 0 } as const),
});
