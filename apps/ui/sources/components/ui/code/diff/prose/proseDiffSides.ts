import type { CodeLine } from '@/components/ui/code/model/codeLineTypes';

/** One line of one side of a prose diff: unchanged, changed on this side, or the gap between two hunks. */
export type ProseDiffLine = Readonly<{
  id: string;
  kind: 'same' | 'changed' | 'gap';
  number: number | null;
  text: string;
}>;

export type ProseDiffSides = Readonly<{ old: readonly ProseDiffLine[]; new: readonly ProseDiffLine[] }>;

/**
 * R5's two sides (P6 U6.6): the canonical text-diff lines split into what each side reads. A side keeps its
 * unchanged context and its own changed lines with its own numbers; hunks are separated by one gap line,
 * and the hunk header (a code-diff device) is never shown in prose.
 */
export function buildProseDiffSides(lines: readonly CodeLine[]): ProseDiffSides {
  const old: ProseDiffLine[] = [];
  const next: ProseDiffLine[] = [];
  // A hunk boundary becomes a gap on a side only between two lines that side shows.
  let gap: string | null = null;
  const pending = { old: false, new: false };
  const push = (side: 'old' | 'new', line: ProseDiffLine) => {
    const target = side === 'old' ? old : next;
    if (pending[side] && gap !== null && target.length > 0) {
      target.push({ id: `${gap}:${side}`, kind: 'gap', number: null, text: '' });
    }
    pending[side] = false;
    target.push(line);
  };
  for (const line of lines) {
    if (line.kind === 'header') {
      gap = line.id;
      pending.old = true;
      pending.new = true;
      continue;
    }
    if (line.kind === 'remove') {
      push('old', { id: line.id, kind: 'changed', number: line.oldLine, text: line.renderCodeText });
    } else if (line.kind === 'add') {
      push('new', { id: line.id, kind: 'changed', number: line.newLine, text: line.renderCodeText });
    } else if (line.kind === 'context') {
      push('old', { id: `${line.id}:old`, kind: 'same', number: line.oldLine, text: line.renderCodeText });
      push('new', { id: `${line.id}:new`, kind: 'same', number: line.newLine, text: line.renderCodeText });
    }
  }
  return { old, new: next };
}

/** One line of the unified prose reading: unchanged, added or removed where it happens, or the gap between hunks. */
export type ProseUnifiedLine = Readonly<{
  id: string;
  kind: 'same' | 'added' | 'removed' | 'gap';
  text: string;
}>;

/**
 * The unified reading of the same canonical text-diff lines: one column in document order, each unchanged
 * line once and each change marked in place (lab `b-work P`, an instructions edit read top to bottom).
 */
export function buildProseUnifiedLines(lines: readonly CodeLine[]): readonly ProseUnifiedLine[] {
  const out: ProseUnifiedLine[] = [];
  for (const line of lines) {
    if (line.kind === 'header') {
      if (out.length > 0) out.push({ id: line.id, kind: 'gap', text: '' });
    } else if (line.kind === 'add') {
      out.push({ id: line.id, kind: 'added', text: line.renderCodeText });
    } else if (line.kind === 'remove') {
      out.push({ id: line.id, kind: 'removed', text: line.renderCodeText });
    } else if (line.kind === 'context') {
      out.push({ id: line.id, kind: 'same', text: line.renderCodeText });
    }
  }
  return out;
}
