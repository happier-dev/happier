import { ForgeCiLogSelectionV1Schema, type ForgeCiLogSelectionV1 } from '@happier-dev/triage-protocol/ci/v1';
import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import type { ForgeCiLogIndexV1, ForgeCiLogLineV1, LogIndexV1 } from './index.js';

export type ForgeCiLogProjectionV1 = Readonly<{
  kind: 'value'; lines: readonly ForgeCiLogLineV1[]; olderRemaining: boolean; ambiguous: boolean; unattributed: boolean;
}> | Readonly<{ kind: 'unavailable'; failure: TriageSourceFailureV1 }>;

/** Presentation of already admitted lines; this never reads or advances a source cursor. */
export type LogLineSelectionV1 = Readonly<{ kind: 'all' }>
  | Readonly<{ kind: 'tail'; lines: number }>
  | Readonly<{ kind: 'excerpt'; startLine: number; endLine: number }>;

export function selectLogLinesV1(
  index: Pick<LogIndexV1, 'lines' | 'complete' | 'continuation'>,
  selection: LogLineSelectionV1,
): ForgeCiLogProjectionV1 {
  let lines = index.lines;
  if (selection.kind === 'tail') {
    if (!ForgeCiLogSelectionV1Schema.safeParse(selection).success) {
      return { kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'invalid_log_tail' } };
    }
    lines = lines.slice(-selection.lines);
  }
  if (selection.kind === 'excerpt') {
    if (!Number.isSafeInteger(selection.startLine) || !Number.isSafeInteger(selection.endLine)
      || selection.startLine < 1 || selection.endLine < selection.startLine) {
      return { kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'invalid_log_excerpt' } };
    }
    lines = lines.filter(line => line.number >= selection.startLine && line.number <= selection.endLine);
  }
  return { kind: 'value', lines, olderRemaining: !index.complete || index.continuation !== null || lines.length < index.lines.length,
    ambiguous: lines.some(line => line.attribution.kind === 'ambiguous'), unattributed: lines.some(line => line.attribution.kind === 'unattributed') };
}

/** Selects already-indexed original lines; uncertainty context is never silently attributed or dropped. */
export function selectForgeCiLogLinesV1(index: ForgeCiLogIndexV1, selection: ForgeCiLogSelectionV1 | LogLineSelectionV1): ForgeCiLogProjectionV1 {
  if (selection.kind !== 'steps') return selectLogLinesV1(index, selection);
  let lines = index.lines;
  if (selection.kind === 'steps') {
    if (index.steps.length === 0) return { kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'steps_unsupported' } };
    const requested = new Set(selection.stepIds);
    if (selection.stepIds.some(id => !index.steps.some(step => step.id === id))) {
      return { kind: 'unavailable', failure: { class: 'unsupportedContract', code: 'invalid_step_selection' } };
    }
    lines = lines.filter(line => line.attribution.kind === 'unattributed' || line.attribution.stepIds.some(id => requested.has(id)));
  }
  return { kind: 'value', lines, olderRemaining: !index.complete || index.continuation !== null,
    ambiguous: lines.some(line => line.attribution.kind === 'ambiguous'), unattributed: lines.some(line => line.attribution.kind === 'unattributed') };
}
