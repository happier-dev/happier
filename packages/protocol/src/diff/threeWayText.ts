import { z } from 'zod/mini';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { diffArrays } from 'diff';
import { applyHunks, type HunkLine } from './hunks.js';

export const ThreeWayTextChoiceV1Schema = lazyZodSchema(() => z.enum(['mine', 'theirs', 'both']));
export type ThreeWayTextChoiceV1 = z.infer<typeof ThreeWayTextChoiceV1Schema>;
export const ThreeWayTextComparisonV1Schema = lazyZodSchema(() => z.strictObject({
  segments: z.array(z.strictObject({ index: z.number().check(z.int(), z.nonnegative()),
    kind: z.enum(['unchanged', 'mine', 'theirs', 'same', 'conflict']), base: z.string(), mine: z.string(), theirs: z.string() })),
  text: z.string(),
}));
export type ThreeWayTextComparisonV1 = z.infer<typeof ThreeWayTextComparisonV1Schema>;
export function resolveThreeWayTextV1(comparison: ThreeWayTextComparisonV1, choices: Readonly<Record<string, ThreeWayTextChoiceV1>> = {}): string {
  return comparison.segments.map(segment => segment.kind === 'theirs' ? segment.theirs
    : segment.kind !== 'conflict' || choices[segment.index] === undefined || choices[segment.index] === 'mine' ? segment.mine
      : choices[segment.index] === 'both' ? segment.mine + segment.theirs : segment.theirs).join('');
}
export function compareThreeWayTextV1(base: string, mine: string, theirs: string): ThreeWayTextComparisonV1 {
  // Tokens include their terminator: CRLF, trailing LF and an absent final LF remain content.
  const lines = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const original = lines(base);
  type Edit = { start: number; end: number; replacement: string[]; side: 'mine' | 'theirs' };
  const edits = (text: string, side: Edit['side']): Edit[] => {
    const result: Edit[] = [];
    let position = 0;
    let pending: Edit | undefined;
    for (const part of diffArrays(original, lines(text))) {
      if (!part.added && !part.removed) {
        if (pending) result.push(pending);
        pending = undefined;
        position += part.value.length;
      } else {
        pending ??= { start: position, end: position, replacement: [], side };
        if (part.removed) { position += part.value.length; pending.end = position; }
        else for (const token of part.value) pending.replacement.push(token);
      }
    }
    if (pending) result.push(pending);
    return result;
  };
  const overlaps = (a: Edit, b: Edit): boolean => a.start === a.end
    ? b.start === b.end ? a.start === b.start : b.start < a.start && a.start < b.end
    : b.start === b.end ? a.start < b.start && b.start < a.end : a.start < b.end && b.start < a.end;
  const groups: Edit[][] = [];
  for (const edit of [...edits(mine, 'mine'), ...edits(theirs, 'theirs')].sort((a, b) => a.start - b.start || a.end - b.end)) {
    const last = groups.at(-1);
    if (last?.some(previous => overlaps(previous, edit))) last.push(edit);
    else groups.push([edit]);
  }
  const hunkLine = (token: string, kind: HunkLine['kind']): HunkLine => ({ kind,
    text: token.endsWith('\n') ? token.slice(0, -1) : token, ...(!token.endsWith('\n') ? { noEol: true } : {}) });
  const render = (start: number, end: number, group: Edit[], side: Edit['side']): string => {
    const slice = original.slice(start, end).join('');
    const hunks = group.filter(edit => edit.side === side).map((edit, index) => ({ index,
      oldStart: edit.start - start + (edit.start === edit.end ? 0 : 1), oldLines: edit.end - edit.start,
      newStart: edit.start - start + (edit.replacement.length ? 1 : 0), newLines: edit.replacement.length,
      sectionHeading: '', firstChange: 0, lastChange: edit.end - edit.start + edit.replacement.length - 1,
      lines: [...original.slice(edit.start, edit.end).map(token => hunkLine(token, 'remove')),
        ...edit.replacement.map(token => hunkLine(token, 'add'))],
    }));
    const result = applyHunks(slice, hunks);
    if (!result.ok) throw new Error(`Invalid three-way edit: ${result.reason}`);
    return result.text;
  };
  const segments: ThreeWayTextComparisonV1['segments'] = [];
  const push = (kind: ThreeWayTextComparisonV1['segments'][number]['kind'], before: string, local: string, author: string) => {
    if (before || local || author) segments.push({ index: segments.length, kind, base: before, mine: local, theirs: author });
  };
  let cursor = 0;
  for (const group of groups) {
    const start = group[0]!.start;
    const end = group.reduce((maximum, edit) => Math.max(maximum, edit.end), start);
    const unchanged = original.slice(cursor, start).join('');
    push('unchanged', unchanged, unchanged, unchanged);
    const before = original.slice(start, end).join('');
    const local = render(start, end, group, 'mine');
    const author = render(start, end, group, 'theirs');
    const kind = local === author ? 'same' : local === before ? 'theirs' : author === before ? 'mine' : 'conflict';
    push(kind, before, local, author);
    cursor = end;
  }
  const unchanged = original.slice(cursor).join('');
  push('unchanged', unchanged, unchanged, unchanged);
  const comparison = { segments, text: '' };
  comparison.text = resolveThreeWayTextV1(comparison);
  return comparison;
}
