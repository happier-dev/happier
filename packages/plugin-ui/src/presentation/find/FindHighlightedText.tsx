import * as React from 'react';
import type { ReactNode } from 'react';
import { HappierText } from '../text/Text.js';
import type { FindTextRange } from './findTypes.js';

export type FindMarkStyle = Readonly<{ backgroundColor: string; color?: string; borderRadius?: number; boxShadow?: string }>;
export type HappierFindHighlightedTextProps = Readonly<{
  text: string;
  ranges?: readonly FindTextRange[];
  selectable?: boolean;
  marks: Readonly<{ all: FindMarkStyle; current: FindMarkStyle }>;
  /** Core binds its text adapter; plugin text inherits the parent typography. */
  renderMatch?: (input: Readonly<{ key: number; text: string; current: boolean; style: FindMarkStyle; selectable?: boolean }>) => ReactNode;
}>;

/** Inline children for a parent Text/HappierText. Half-open UTF-16 ranges keep the selected overlap on top. */
export function HappierFindHighlightedText(props: HappierFindHighlightedTextProps): React.ReactNode {
  if (!props.ranges?.length) return props.text;
  const events = new Map<number, { all: number; current: number }>([[0, { all: 0, current: 0 }], [props.text.length, { all: 0, current: 0 }]]);
  const addEvent = (offset: number, delta: number, current: boolean) => {
    const event = events.get(offset) ?? { all: 0, current: 0 };
    event.all += delta;
    if (current) event.current += delta;
    events.set(offset, event);
  };
  for (const range of props.ranges) {
    const start = Math.max(0, Math.min(props.text.length, range.start));
    const end = Math.max(0, Math.min(props.text.length, range.end));
    if (end <= start) continue;
    addEvent(start, 1, range.current);
    addEvent(end, -1, range.current);
  }
  const positions = [...events.keys()].sort((a, b) => a - b);
  let active = 0;
  let activeCurrent = 0;
  return <>{positions.slice(0, -1).map((start, index) => {
    const event = events.get(start)!;
    active += event.all;
    activeCurrent += event.current;
    const end = positions[index + 1]!;
    if (end <= start) return null;
    const text = props.text.slice(start, end);
    const current = activeCurrent > 0;
    if (active <= 0) return text;
    const style = current ? props.marks.current : props.marks.all;
    return props.renderMatch ? props.renderMatch({ key: start, text, current, style, selectable: props.selectable })
      : <HappierText key={start} selectable={props.selectable} testID={current ? 'find-match-current' : 'find-match-all'} style={style}>{text}</HappierText>;
  })}</>;
}

export function sliceFindRanges(ranges: readonly FindTextRange[] | undefined, start: number, length: number): FindTextRange[] | undefined {
  return ranges?.filter((range) => range.end > start && range.start < start + length)
    .map((range) => ({ start: Math.max(0, range.start - start), end: Math.min(length, range.end - start), current: range.current }));
}
