/**
 * Shared table-layout primitives for the session list/selector surfaces.
 *
 * `renderSessionListTable.ts` (text-mode) and `SessionActionSelector.tsx`
 * (Ink) both need the same "allocate proportional widths to title/path,
 * keep fixed-width columns for id/agent/updated, never overflow the
 * terminal" logic. We extract the primitives here so the two renderers
 * can't drift on truncation or column sizing.
 */

export function truncateEnd(value: string, width: number): string {
  const text = String(value ?? '');
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width <= 1) return text.slice(0, width);
  return text.slice(0, width - 1) + '…';
}

/**
 * Truncate a path-like string from the middle so the leading prefix and
 * trailing folder are both preserved. More recognisable than end-truncation
 * for long paths: `~/.../atlas` reads better than `~/Documents/Develo…`.
 */
export function truncateMiddle(value: string, width: number): string {
  const text = String(value ?? '');
  if (width <= 0) return '';
  if (text.length <= width) return text;
  if (width <= 3) return text.slice(0, width);
  const ellipsis = '…';
  const remaining = width - ellipsis.length;
  // Slightly weight toward the trailing tail so the recognisable folder
  // (e.g. the project name at the end) stays visible. 0.4 / 0.6 split.
  const headLen = Math.floor(remaining * 0.4);
  const tailLen = remaining - headLen;
  return text.slice(0, headLen) + ellipsis + text.slice(text.length - tailLen);
}

export function padRight(value: string, width: number): string {
  const text = String(value ?? '');
  if (text.length >= width) return text;
  return text + ' '.repeat(width - text.length);
}

export function padLeft(value: string, width: number): string {
  const text = String(value ?? '');
  if (text.length >= width) return text;
  return ' '.repeat(width - text.length) + text;
}

/**
 * Allocate column widths for an attach/resume selector row. Title and path
 * share the remaining space proportionally; the rest are fixed-width.
 *
 * Returns null when the terminal is too narrow to show useful columns at
 * all — caller can fall back to a single-column layout.
 */
export type SessionSelectorColumnLayout = Readonly<{
  indicatorWidth: number;
  titleWidth: number;
  agentWidth: number;
  updatedWidth: number;
  idWidth: number;
  pathWidth: number;
  /** Width of one space between cells. */
  separatorWidth: number;
}>;

export function resolveSessionSelectorColumnLayout(termWidth: number): SessionSelectorColumnLayout | null {
  const indicatorWidth = 2;     // `› ` or `  `
  const agentWidth = 8;          // 'opencode' is the longest agent id we ship
  const updatedWidth = 4;        // '14h' / '2m'
  const idWidth = 9;             // shortened id is 8 chars + ellipsis
  const separatorWidth = 1;      // single space between cells
  const fixedWidths = indicatorWidth + agentWidth + updatedWidth + idWidth;
  const separators = separatorWidth * 5; // 6 columns → 5 gaps
  const remaining = termWidth - fixedWidths - separators;
  if (remaining < 20) return null; // less than 10 chars each for title+path is unreadable
  // Title gets 35%, path gets 65% — paths are the bigger string and the
  // user's most-recognised cell. Title-truncation is fine because it's
  // usually a short slug.
  const titleWidth = Math.max(8, Math.floor(remaining * 0.35));
  const pathWidth = Math.max(8, remaining - titleWidth - separatorWidth);
  return {
    indicatorWidth,
    titleWidth,
    agentWidth,
    updatedWidth,
    idWidth,
    pathWidth,
    separatorWidth,
  };
}
