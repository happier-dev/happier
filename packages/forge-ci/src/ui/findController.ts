import {
  matchFindText, type FindController, type FindOptions, type FindStatus, type FindTextRange,
} from '@happier-dev/plugin-ui/components';
import type { ForgeCiLogIndexV1, ForgeCiLogLineV1, LogIndexV1 } from '../runtime/logs/index.js';
import { adaptForgeCiLogViewV1, type ForgeCiMountedViewV1, type LogViewV1, type LogViewOperationV1 } from './mountedCiIntent.js';

export type ForgeCiLogFindMatchV1 = Readonly<{ start: number; end: number; line: ForgeCiLogLineV1 }>;
export type LogFindSnapshotV1<Index extends LogIndexV1 = LogIndexV1> = Readonly<{
  index: Index; query: string; options: FindOptions; status: FindStatus;
  matches: readonly ForgeCiLogFindMatchV1[]; isOpen: boolean;
}>;
export interface LogFindControllerV1<Index extends LogIndexV1 = LogIndexV1> extends FindController {
  open(): void;
  getSnapshot(): LogFindSnapshotV1<Index>;
  subscribe(listener: () => void): () => void;
  setIndex(index: Index, coverage?: Readonly<{ partialErrors?: boolean }>): void;
  getLineRanges(lineId: string): readonly FindTextRange[];
  revealLine(lineNumber: number): void;
  refold(): 'refolded' | 'noRevealedFold';
}
export type ForgeCiLogFindSnapshotV1 = LogFindSnapshotV1<ForgeCiLogIndexV1>;
export type ForgeCiLogFindControllerV1 = LogFindControllerV1<ForgeCiLogIndexV1>;

type LineMatch = Readonly<{ start: number; end: number; match: number }>;
const EMPTY_RANGES: readonly FindTextRange[] = Object.freeze([]);

/** Find owns query/highlights; the mounted CI owner retains folds, step and timestamp state. */
export function createForgeCiLogFindControllerV1(input: Readonly<{
  index: ForgeCiLogIndexV1;
  view: ForgeCiMountedViewV1;
  onRevealLine?: (line: ForgeCiLogLineV1) => void;
  /** The caller's existing physical focus owner returns focus to the log. */
  onClose?: () => void;
}>): ForgeCiLogFindControllerV1 {
  let currentJob = input.index.job;
  const controller = createLogFindControllerV1({ ...input, view: adaptForgeCiLogViewV1(input.view, () => currentJob) });
  const setIndex = controller.setIndex;
  controller.setIndex = (next, coverage) => {
    if (next.sourceKey !== controller.getSnapshot().index.sourceKey) controller.refold();
    currentJob = next.job;
    setIndex(next, coverage);
  };
  return controller;
}

/** One matcher/highlight owner. Physical hosts supply their existing mounted controls and focus. */
export function createLogFindControllerV1<Index extends LogIndexV1>(input: Readonly<{
  index: Index; view: LogViewV1; onRevealLine?: (line: ForgeCiLogLineV1) => void; onClose?: () => void;
}>): LogFindControllerV1<Index> {
  let index = input.index;
  let partialErrors = false;
  let query = '';
  let options: FindOptions = Object.freeze({ matchCase: false, regex: false });
  let isOpen = false;
  let current: number | null = null;
  let invalid = false;
  let matches: readonly ForgeCiLogFindMatchV1[] = Object.freeze([]);
  let lineMatches = new Map<string, readonly LineMatch[]>();
  let lineIdsByMatch: readonly (readonly string[])[] = [];
  let ranges = new Map<string, readonly FindTextRange[]>();
  let linesByNumber = new Map(index.lines.map(line => [line.number, line]));
  const temporarilyOpened = new Set<string>();
  const listeners = new Set<() => void>();
  let unsubscribeMount: (() => void) | undefined;
  let applying = false;
  let previousGroups = input.view.getSnapshot()?.groupExpanded;

  function status(): FindStatus {
    if (query.length === 0) return { kind: 'idle' };
    if (invalid) return { kind: 'invalidPattern' };
    return { kind: 'results', current: current === null ? null : current + 1, total: matches.length,
      coverage: partialErrors ? 'partialErrors' : index.complete && index.continuation === null ? 'complete' : 'loaded' };
  }
  function snapshot(): LogFindSnapshotV1<Index> { return { index, query, options, status: status(), matches, isOpen }; }
  let value = snapshot();
  function publish() {
    value = snapshot();
    for (const listener of listeners) listener();
  }
  function apply(operation: LogViewOperationV1) {
    applying = true;
    try { input.view.invoke(operation); }
    finally { applying = false; }
  }
  function firstLineAt(offset: number): number {
    let low = 0;
    let high = index.lines.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (index.lines[middle]!.plainOffset <= offset) low = middle + 1;
      else high = middle;
    }
    return Math.max(0, low - 1);
  }
  function updateRanges(ids: Iterable<string>) {
    for (const id of ids) ranges.set(id, (lineMatches.get(id) ?? []).map(range => ({
      start: range.start, end: range.end, current: range.match === current,
    })));
  }
  function search() {
    const result = matchFindText(index.plainText, query, options);
    invalid = 'invalidPattern' in result;
    const next: ForgeCiLogFindMatchV1[] = [];
    const byLine = new Map<string, LineMatch[]>();
    const byMatch: string[][] = [];
    for (const [start, end] of 'ranges' in result ? result.ranges : []) {
      const first = firstLineAt(start);
      const line = index.lines[first];
      if (!line) continue;
      const last = firstLineAt(Math.max(start, end - 1));
      let crossesUnloadedRange = false;
      for (let i = first + 1; i <= last; i++) {
        if (index.lines[i]!.number !== index.lines[i - 1]!.number + 1) { crossesUnloadedRange = true; break; }
      }
      if (crossesUnloadedRange) continue;
      const match = next.length;
      next.push({ start, end, line });
      const ids: string[] = [];
      for (let i = first; i < index.lines.length; i++) {
        const row = index.lines[i]!;
        if (i !== first && row.plainOffset >= end) break;
        const localStart = Math.max(0, start - row.plainOffset);
        const localEnd = Math.min(row.plainText.length, end - row.plainOffset);
        if (localStart <= localEnd) {
          const entries = byLine.get(row.id) ?? [];
          entries.push({ start: localStart, end: localEnd, match });
          byLine.set(row.id, entries);
          ids.push(row.id);
        }
      }
      byMatch.push(ids);
    }
    matches = next;
    current = next.length > 0 ? 0 : null;
    lineMatches = byLine;
    lineIdsByMatch = byMatch;
    ranges = new Map();
    updateRanges(byLine.keys());
  }
  function reveal(line: ForgeCiLogLineV1) {
    const mounted = input.view.getSnapshot();
    if (!mounted || input.view.isAvailable?.() === false) return;
    if (mounted.selection.kind === 'tail') {
      const lines = index.lines.length - firstLineAt(line.plainOffset);
      if (lines > mounted.selection.lines) apply({ kind: 'setSelection', selection: { kind: 'tail', lines } });
    } else if (mounted.selection.kind === 'excerpt' && (line.number < mounted.selection.startLine || line.number > mounted.selection.endLine)) {
      apply({ kind: 'setSelection', selection: { kind: 'excerpt', startLine: Math.min(line.number, mounted.selection.startLine),
        endLine: Math.max(line.number, mounted.selection.endLine) } });
    }
    for (const groupId of line.groupIds) {
      if (input.view.getSnapshot()?.groupExpanded[groupId] === true) continue;
      apply({ kind: 'setGroupExpanded', groupId, expanded: true });
      if (input.view.getSnapshot()?.groupExpanded[groupId] === true) temporarilyOpened.add(groupId);
    }
    if (line.attribution.kind === 'step' && line.attribution.stepIds.length === 1) {
      input.view.selectStep?.(line.attribution.stepIds[0]!);
    }
    apply({ kind: 'revealLine', line: line.number });
    if (input.view.getSnapshot()?.revealedLine === line.number) input.onRevealLine?.(line);
  }
  function revealCurrent() { if (current !== null) reveal(matches[current]!.line); }
  function refold(): 'refolded' | 'noRevealedFold' {
    let changed = false;
    for (const groupId of temporarilyOpened) {
      if (input.view.getSnapshot()?.groupExpanded[groupId] !== true) continue;
      apply({ kind: 'setGroupExpanded', groupId, expanded: false });
      changed ||= input.view.getSnapshot()?.groupExpanded[groupId] === false;
    }
    temporarilyOpened.clear();
    return changed ? 'refolded' : 'noRevealedFold';
  }
  return {
    get query() { return query; }, get options() { return options; }, get status() { return value.status; },
    capabilities: Object.freeze({ regex: true, stop: false }),
    getSnapshot: () => value,
    subscribe(listener) {
      listeners.add(listener);
      if (!unsubscribeMount) {
        previousGroups = input.view.getSnapshot()?.groupExpanded;
        unsubscribeMount = input.view.subscribe(() => {
          const groups = input.view.getSnapshot()?.groupExpanded;
          if (!applying) for (const id of temporarilyOpened) {
            if (previousGroups?.[id] !== groups?.[id]) temporarilyOpened.delete(id);
          }
          previousGroups = groups;
        });
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) { unsubscribeMount?.(); unsubscribeMount = undefined; }
      };
    },
    open() { if (!isOpen) { isOpen = true; publish(); } },
    setQuery(next) {
      if (next === query) return;
      query = next;
      search();
      revealCurrent();
      publish();
    },
    setOptions(next) {
      if (next.matchCase === options.matchCase && next.regex === options.regex) return;
      options = Object.freeze({ ...next });
      search();
      revealCurrent();
      publish();
    },
    step(direction) {
      if (matches.length === 0) return;
      const previous = current;
      current = current === null ? direction === 1 ? 0 : matches.length - 1 : (current + direction + matches.length) % matches.length;
      if (previous !== current) {
        updateRanges(new Set([...(previous === null ? [] : lineIdsByMatch[previous]!), ...lineIdsByMatch[current]!]));
        publish();
      }
      revealCurrent();
    },
    stop() {},
    refold,
    close() {
      refold();
      if (!isOpen && query.length === 0) return;
      const restoreFocus = isOpen;
      isOpen = false;
      query = '';
      search();
      publish();
      if (restoreFocus) input.onClose?.();
    },
    setIndex(next, coverage) {
      const failed = coverage?.partialErrors === true;
      if (next === index && failed === partialErrors) return;
      const changedLines = next.lines !== index.lines || next.plainText !== index.plainText;
      if (next.logId !== index.logId || next.sourceKey !== index.sourceKey || next.positionBasis !== index.positionBasis) refold();
      index = next;
      partialErrors = failed;
      if (changedLines) { linesByNumber = new Map(index.lines.map(line => [line.number, line])); search(); revealCurrent(); }
      publish();
    },
    getLineRanges: lineId => ranges.get(lineId) ?? EMPTY_RANGES,
    revealLine(lineNumber) { const line = linesByNumber.get(lineNumber); if (line) reveal(line); },
  };
}
