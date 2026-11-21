import * as React from 'react';

import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

import { readPierreDomLine } from './pierreDomLine';

/**
 * The code view's leading lane on Pierre (the blame column, Explain's caption letters): one cell per mounted line,
 * beside its gutter, drawn by the caller's `renderLeadingLane` exactly as the canonical line renderer draws it.
 * Pierre has no per-line gutter slot, so the cells are the light-DOM column over the room the adapter reserves at
 * the start of each line (`--happier-leading-lane-width`), positioned at the rows Pierre has mounted. A diff
 * without a lane mounts none of this and reads no row.
 */

export type PierreLeadingLaneRow = Readonly<{
  line: CodeLine;
  top: number;
  height: number;
}>;

export const PIERRE_LEADING_LANE_WIDTH_VAR = '--happier-leading-lane-width';

/** Static: the reserved room is a variable, so a lane appearing never changes Pierre's CSS (which re-measures rows). */
export const PIERRE_LEADING_LANE_UNSAFE_CSS = `
[data-code] { padding-left: var(${PIERRE_LEADING_LANE_WIDTH_VAR}, 0px); }
`;

/** The rows Pierre mounted, by the line each one draws, relative to the lane's frame (one per visual row). */
export function readPierreLeadingLaneRows(
  input: Readonly<{
    root: ParentNode;
    frame: HTMLElement;
    /** Split rows pair two gutters at one height; a unified row has one. */
    split: boolean;
    lineAt: (
      position: Readonly<{ oldLine: number | null; newLine: number | null }>,
    ) => CodeLine | undefined;
  }>,
): readonly PierreLeadingLaneRow[] {
  const origin = input.frame.getBoundingClientRect().top;
  const rows: PierreLeadingLaneRow[] = [];
  const byTop = new Map<number, PierreLeadingLaneRow>();
  for (const gutter of input.root.querySelectorAll<HTMLElement>(
    '[data-column-number]',
  )) {
    const position = readPierreDomLine(gutter);
    const line = position ? input.lineAt(position) : undefined;
    if (!line) continue;
    const rect = gutter.getBoundingClientRect();
    const top = Math.round(rect.top - origin);
    // A split row pairs two gutters at one height: the new side's line speaks for it.
    if (!input.split) {
      rows.push({ line, top, height: rect.height });
      continue;
    }
    const existing = byTop.get(top);
    if (existing && existing.line.newLine !== null) continue;
    byTop.set(top, { line, top, height: rect.height });
  }
  return input.split ? [...byTop.values()].sort((a, b) => a.top - b.top) : rows;
}

export function samePierreLeadingLaneRows(
  a: readonly PierreLeadingLaneRow[],
  b: readonly PierreLeadingLaneRow[],
): boolean {
  return (
    a.length === b.length &&
    a.every((row, index) => {
      const other = b[index]!;
      return (
        row.line === other.line &&
        row.top === other.top &&
        row.height === other.height
      );
    })
  );
}

const CELL_BASE: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  display: 'flex',
  flexDirection: 'row',
  alignItems: 'stretch',
};
const LANE_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  pointerEvents: 'none',
};

/** The lane's cells; it reports its widest cell so the adapter reserves exactly that room. */
export const PierreLeadingLane = React.memo(function PierreLeadingLane(
  props: Readonly<{
    rows: readonly PierreLeadingLaneRow[];
    renderLeadingLane: (line: CodeLine) => React.ReactNode;
    onWidth: (width: number) => void;
  }>,
) {
  const laneRef = React.useRef<HTMLDivElement | null>(null);
  const { onWidth } = props;
  React.useLayoutEffect(() => {
    const lane = laneRef.current;
    if (!lane) return;
    let width = 0;
    for (const cell of lane.children)
      width = Math.max(
        width,
        (cell as HTMLElement).getBoundingClientRect().width,
      );
    onWidth(Math.ceil(width));
  });
  return (
    <div ref={laneRef} data-happier-leading-lane="" style={LANE_STYLE}>
      {props.rows.map((row) => (
        <div
          key={row.line.id}
          style={{
            ...CELL_BASE,
            top: row.top,
            height: row.height,
            pointerEvents: 'auto',
          }}
        >
          {props.renderLeadingLane(row.line)}
        </div>
      ))}
    </div>
  );
});
