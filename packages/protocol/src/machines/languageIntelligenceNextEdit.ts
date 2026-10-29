import { applyWorkspaceFileTextEdits, workspaceTextPositionToOffset } from './workspaceFilesReplace.js';
import { LanguageIntelligencePathSchema, LanguageIntelligencePredictedEditSchema,
  type LanguageIntelligenceNextEditInput, type LanguageIntelligencePredictedEdit, type LanguageIntelligenceRange, type LanguageIntelligenceEdit } from './languageIntelligence.js';

type Document = Readonly<{ path: string; text: string; version: number }>;

function offset(text: string, position: LanguageIntelligenceRange['start']) {
  const result = workspaceTextPositionToOffset(text, position);
  const before = text.charCodeAt(result - 1), after = text.charCodeAt(result);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) throw new Error('Split surrogate');
  return result;
}
function span(text: string, range: LanguageIntelligenceRange) {
  const start = offset(text, range.start), end = offset(text, range.end);
  if (end < start) throw new Error('Reversed range');
  return { start, end };
}

/** The same admission at the Machine, before display, and synchronously before an engine transaction. */
export function validateLanguageIntelligenceNextEdit(
  captured: Document, current: Document, edits: readonly LanguageIntelligencePredictedEdit[], target?: LanguageIntelligenceRange,
): readonly LanguageIntelligencePredictedEdit[] | null {
  if (captured.path !== current.path || captured.text !== current.text || captured.version !== current.version
    || !LanguageIntelligencePathSchema.safeParse(captured.path).success) return null;
  try {
    const region = target ? span(captured.text, target) : { start: 0, end: captured.text.length };
    const spans = edits.map(edit => {
      if (!LanguageIntelligencePredictedEditSchema.safeParse(edit).success || edit.path !== captured.path) throw new Error('Invalid target');
      const range = span(captured.text, edit.range);
      if (range.start < region.start || range.end > region.end || captured.text.slice(range.start, range.end) !== edit.oldText) throw new Error('Stale text');
      return { ...range, edit };
    }).sort((left, right) => left.start - right.start || left.end - right.end);
    for (let index = 1; index < spans.length; index++) {
      const previous = spans[index - 1], next = spans[index];
      if (next.start < previous.end || next.start === previous.start) return null;
    }
    // This canonical transform also rejects unpaired Unicode and returns the preview's exact bytes.
    applyWorkspaceFileTextEdits(captured.text, spans.map(({ edit }) => ({ range: edit.range, text: edit.newText })));
    return spans.flatMap(({ edit }) => edit.oldText === edit.newText ? [] : [edit]);
  } catch { return null; }
}

/** History is chronological, from the active file only, and reverses exactly to its captured bases. */
export function validateLanguageIntelligenceNextEditInput(input: LanguageIntelligenceNextEditInput, version: number): boolean {
  return readHistory(input, version) !== null;
}

function readHistory(input: LanguageIntelligenceNextEditInput, version: number) {
  try {
    const target = span(input.document, input.target.range);
    if (input.document.slice(target.start, target.end) !== input.target.text || input.recentEdits.length === 0) return null;
    let text = input.document, currentVersion = version;
    const history: { original: string; updated: string }[] = [];
    for (const edit of [...input.recentEdits].reverse()) {
      if (edit.version !== currentVersion || edit.baseVersion >= edit.version) return null;
      const start = offset(text, edit.range.start);
      if (text.slice(start, start + edit.newText.length) !== edit.newText) return null;
      const previous = text.slice(0, start) + edit.oldText + text.slice(start + edit.newText.length);
      const range = span(previous, edit.range);
      if (previous.slice(range.start, range.end) !== edit.oldText) return null;
      applyWorkspaceFileTextEdits(previous, [{ range: edit.range, text: edit.newText }]);
      history.push({ original: previous, updated: text });
      text = previous; currentVersion = edit.baseVersion;
    }
    return history.reverse();
  } catch { return null; }
}

function positionAt(text: string, end: number) {
  let line = 0, character = 0;
  for (let index = 0; index < end; index++) {
    if (text[index] === '\r') { if (text[index + 1] === '\n' && index + 1 < end) index++; line++; character = 0; }
    else if (text[index] === '\n') { line++; character = 0; }
    else character++;
  }
  return { line, character };
}
function splitsUnit(text: string, offset: number) {
  const previous = text.charCodeAt(offset - 1), next = text.charCodeAt(offset);
  return previous === 13 && next === 10 || previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
}

/** Canonical single replacement for editor synchronization and chronological history. */
export function diffLanguageIntelligenceText(previous: string, next: string): LanguageIntelligenceEdit | null {
  if (previous === next) return null;
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  if (splitsUnit(previous, start) || splitsUnit(next, start)) start--;
  let oldEnd = previous.length, newEnd = next.length;
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
  if (splitsUnit(previous, oldEnd) || splitsUnit(next, newEnd)) { oldEnd++; newEnd++; }
  const from = positionAt(previous, start), to = positionAt(previous, oldEnd);
  return { startLine: from.line, startCharacter: from.character, endLine: to.line, endCharacter: to.character, text: next.slice(start, newEnd) };
}

type SequenceChange = Readonly<{ start: number; end: number; nextStart: number; nextEnd: number }>;

/** LCS with linear working memory. Equal prefixes/suffixes and disjoint token
 * sets avoid a matrix for the common small-change and whole-rewrite cases. */
function sequenceChanges(previous: readonly string[], next: readonly string[]): SequenceChange[] {
  const matches: [number, number][] = [];
  function row(a: number, end: number, b: number, stop: number, reverse: boolean) {
    const scores = new Uint32Array(stop - b + 1);
    for (let index = 0; index < end - a; index++) {
      let diagonal = 0;
      for (let column = 1; column < scores.length; column++) {
        const above = scores[column];
        scores[column] = previous[reverse ? end - index - 1 : a + index] === next[reverse ? stop - column : b + column - 1]
          ? diagonal + 1 : Math.max(above, scores[column - 1]);
        diagonal = above;
      }
    }
    return scores;
  }
  function splitAt(a: number, middle: number, end: number, b: number, stop: number) {
    const left = row(a, middle, b, stop, false), right = row(middle, end, b, stop, true);
    let split = 0;
    for (let index = 1; index <= stop - b; index++) {
      if (left[index] + right[stop - b - index] > left[split] + right[stop - b - split]) split = index;
    }
    return b + split;
  }
  function align(a: number, end: number, b: number, stop: number): void {
    while (a < end && b < stop && previous[a] === next[b]) { matches.push([a++, b++]); }
    let suffix = 0;
    while (a < end - suffix && b < stop - suffix && previous[end - suffix - 1] === next[stop - suffix - 1]) suffix++;
    const oldEnd = end - suffix, newEnd = stop - suffix;
    if (a < oldEnd && b < newEnd) {
      if (oldEnd - a === 1) {
        const match = next.indexOf(previous[a], b);
        if (match >= b && match < newEnd) matches.push([a, match]);
      } else {
        const values = new Set(previous.slice(a, oldEnd));
        if (next.slice(b, newEnd).some(value => values.has(value))) {
          const middle = a + Math.floor((oldEnd - a) / 2);
          const split = splitAt(a, middle, oldEnd, b, newEnd);
          align(a, middle, b, split); align(middle, oldEnd, split, newEnd);
        }
      }
    }
    for (let index = 0; index < suffix; index++) matches.push([oldEnd + index, newEnd + index]);
  }
  align(0, previous.length, 0, next.length);
  const changes: SequenceChange[] = [];
  let start = 0, nextStart = 0;
  for (const [end, nextEnd] of [...matches, [previous.length, next.length]]) {
    if (start !== end || nextStart !== nextEnd) changes.push({ start, end, nextStart, nextEnd });
    start = end + 1; nextStart = nextEnd + 1;
  }
  return changes;
}

/** Keep unchanged lines and intraline tokens out of the prediction. Identifier
 * tokens keep a rename readable; compact trimming removes their equal edges.
 * CRLF and Unicode scalars remain indivisible at both levels. */
function rewriteChanges(previous: string, next: string) {
  const lines = (text: string) => text.match(/[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/gu) ?? [];
  const words = (text: string) => text.match(/\r\n|[\p{L}\p{N}\p{M}_$]+|[^\r\n\p{L}\p{N}\p{M}_$]|[\r\n]/gu) ?? [];
  const before = lines(previous), after = lines(next);
  const offsets = [0];
  for (const line of before) offsets.push(offsets.at(-1)! + line.length);
  const changes: { start: number; end: number; text: string }[] = [];
  for (const block of sequenceChanges(before, after)) {
    // Pair changed lines in order, leaving whole inserted/deleted lines intact.
    const pairs = Math.min(block.end - block.start, block.nextEnd - block.nextStart);
    for (let index = 0; index < pairs; index++) {
      const oldLine = before[block.start + index], newLine = after[block.nextStart + index];
      const oldWords = words(oldLine), newWords = words(newLine), wordOffsets = [0];
      for (const word of oldWords) wordOffsets.push(wordOffsets.at(-1)! + word.length);
      for (const part of sequenceChanges(oldWords, newWords)) {
        const oldText = oldWords.slice(part.start, part.end).join(''), newText = newWords.slice(part.nextStart, part.nextEnd).join('');
        const compact = diffLanguageIntelligenceText(oldText, newText);
        if (!compact) continue;
        // Word blocks may contain a line ending only at their end. Positions
        // from compact trimming therefore map directly through these offsets.
        const base = offsets[block.start + index] + wordOffsets[part.start];
        changes.push({ start: base + offset(oldText, { line: compact.startLine, character: compact.startCharacter }),
          end: base + offset(oldText, { line: compact.endLine, character: compact.endCharacter }), text: compact.text });
      }
    }
    if (block.start + pairs !== block.end || block.nextStart + pairs !== block.nextEnd) changes.push({
      start: offsets[block.start + pairs], end: offsets[block.end], text: after.slice(block.nextStart + pairs, block.nextEnd).join(''),
    });
  }
  // A line-ending change and an adjacent insertion can share an original
  // position. Coalesce only touching changes, never unchanged source text.
  return changes.reduce<typeof changes>((result, change) => {
    const last = result.at(-1);
    if (last && last.end === change.start) result[result.length - 1] = { start: last.start, end: change.end, text: last.text + change.text };
    else result.push(change);
    return result;
  }, []);
}

/** Dedicated raw rewrite-window training format. The final separator newline is
 * included in the prompt, so generated whitespace is always replacement data. */
export function encodeNextEditRewriteWindow(path: string, input: LanguageIntelligenceNextEditInput, version: number): Readonly<{ prompt: string; stop: readonly string[] }> | null {
  if (!LanguageIntelligencePathSchema.safeParse(path).success || /[\r\n]/u.test(path)) return null;
  const history = readHistory(input, version);
  if (!history) return null;
  // This codec has no escape for its reserved framing tokens.
  if ([path, input.document, ...history.flatMap(item => [item.original, item.updated])].some(text => /<\|file_sep\|>|<\/s>/u.test(text))) return null;
  const parts = history.flatMap(item => [`<|file_sep|>${path}.diff`, 'original:', item.original, 'updated:', item.updated]);
  parts.push(`<|file_sep|>original/${path}`, history.at(-1)!.original, `<|file_sep|>current/${path}`, input.document, `<|file_sep|>updated/${path}`, '');
  return { prompt: parts.join('\n'), stop: ['<|file_sep|>', '</s>'] };
}

/** Completion status is supplied by the selected wire decoder. A length stop is
 * never a complete rewrite; there is no generic patch/chat fallback. */
export function decodeNextEditRewriteWindow(path: string, input: LanguageIntelligenceNextEditInput, version: number, output: string, complete: boolean): readonly LanguageIntelligencePredictedEdit[] | null {
  if (!complete || !validateLanguageIntelligenceNextEditInput(input, version) || /<\|file_sep\|>|<\/s>/u.test(output)) return null;
  const region = span(input.document, input.target.range);
  const predicted = rewriteChanges(input.target.text, output).map(edit => ({ path,
    range: { start: positionAt(input.document, region.start + edit.start), end: positionAt(input.document, region.start + edit.end) },
    oldText: input.target.text.slice(edit.start, edit.end), newText: edit.text }));
  const document = { path, text: input.document, version };
  return validateLanguageIntelligenceNextEdit(document, document, predicted, input.target.range);
}
