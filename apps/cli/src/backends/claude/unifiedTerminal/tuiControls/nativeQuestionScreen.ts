import stringWidth from 'string-width';
import { normalizeStructuredQuestionDescriptors, type StructuredQuestionLike } from '@happier-dev/protocol';

import { isClaudeNativePreviewQuestion } from '../../utils/normalizeClaudeAskUserQuestionInput';

import { readClaudeNativeDialogScreenLines } from './nativeScreenCapture';

export type ClaudeNativeQuestionPresentation = Readonly<{
  kind: 'question' | 'review';
  /** Null when the terminal viewport clips off the native tab row. */
  tabs: readonly Readonly<{ header: string; answered: boolean }>[] | null;
  question: string | null;
  multiSelect: boolean;
  nextFocused: boolean;
  /** Preview choices have annotations instead of an inline freeform answer. */
  freeformIndex: number | null;
  notesDraft: boolean;
  options: readonly Readonly<{ label: string; focused: boolean; checked: boolean | null; continuationLines?: readonly string[] }>[];
  /** The review heading and earlier answers are above the viewport. */
  reviewClipped: boolean;
  reviewAnswers: readonly Readonly<{ question: string; answer: string }>[];
}>;

const FOCUS = '[>›❯]';
const ROW = new RegExp(`^\\s*(${FOCUS})?\\s*(\\d+)\\.(?:\\s+(.+?))?\\s*$`, 'u');
const REVIEW_SUBMIT_ROW = new RegExp(`^\\s*${FOCUS}?\\s*1\\. Submit answers$`, 'u');
const RULE = /^[\s─━]+$/u;
const HEADER = /^\s*(?:←\s+)?[☐☒]\s+.+?\s*$/u;
const HINT = /^Enter to select · (?:↑\/↓ to navigate|Tab\/Arrow keys to navigate)(?: · n to add notes)?(?: · Tab to switch questions)?(?: · ctrl\+g to edit in .+)? · Esc to cancel$/u;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function clipDialogLine(line: string, width: number): string {
  if (stringWidth(line) <= width) return line;
  let column = 0;
  for (const { segment, index } of graphemes.segment(line)) {
    column += stringWidth(segment);
    if (column > width) return line.slice(0, index);
  }
  return line;
}

function normalized(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

function matchesRenderedLines(lines: readonly string[], expected: string, allowDescription = false): boolean {
  let text = '';
  for (let index = 0; index < lines.length; index += 1) {
    const next = lines[index]!;
    // Reconstruct only the known provider text: a soft break can occur at a space
    // or inside an unspaced word. Descriptions begin after the complete option label.
    text += expected.startsWith(text + next) ? next : ` ${next}`;
    if (text === expected) return allowDescription || index === lines.length - 1;
    if (!expected.startsWith(text)) return false;
  }
  return false;
}

/** One display-text identity for question recognition, navigation and review. */
export function matchesClaudeNativeQuestionText(actual: string, expected: string): boolean {
  return matchesRenderedLines(actual.split('\n').map(normalized).filter(Boolean), normalized(expected));
}

function matchesOptionLabel(option: ClaudeNativeQuestionPresentation['options'][number], expected: string): boolean {
  return matchesRenderedLines([option.label, ...(option.continuationLines ?? []).map((line) => line.trim())], expected, true);
}

function matchesQuestionHeading(presentation: ClaudeNativeQuestionPresentation, expected: string): boolean {
  if (presentation.tabs !== null) return matchesClaudeNativeQuestionText(presentation.question ?? '', expected);
  const lines = (presentation.question ?? '').split('\n').map(normalized).filter(Boolean);
  const first = lines[0];
  if (!first) return false;
  const text = normalized(expected);
  // The viewport may start in the middle of the question. Match its complete visible
  // suffix, preserving the same word-wrap rules used for full headings and choices.
  for (let start = text.indexOf(first); start >= 0; start = text.indexOf(first, start + 1)) {
    if (matchesRenderedLines(lines, text.slice(start))) return true;
  }
  return false;
}

/** Native question forms characterized against real Claude Code 2.1.304, 309 and 310 tmux captures. */
export function parseClaudeNativeQuestionScreen(rawText: string): ClaudeNativeQuestionPresentation | null {
  let lines = readClaudeNativeDialogScreenLines(rawText);
  let headerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (HEADER.test(lines[index]!)) { headerIndex = index; break; }
  }
  const bodyStart = headerIndex + 1;
  const reviewHeading = lines.slice(bodyStart).find((line) => line.trim().length > 0)?.trim() === 'Review your answers';
  const tail = lines.filter((line) => line.trim().length > 0).slice(-3);
  const reviewClipped = headerIndex < 0 && !reviewHeading
    && tail[0]?.trim() === 'Ready to submit your answers?'
    && REVIEW_SUBMIT_ROW.test(tail[1] ?? '')
    && /^\s*[>›❯]?\s*2\. Cancel$/u.test(tail[2] ?? '');
  const review = reviewHeading || reviewClipped;
  const boundary = /^([─━]+)(?:\s.*)?$/u.exec(lines[headerIndex - 1] ?? '')
    ?? lines.map((line) => /^([─━]+)(?:\s.*)?$/u.exec(line)).reverse().find((match) => match !== null);
  if (!boundary && !review) return null;
  // Claude's split view can place unrelated content beside its dialog. The native
  // rule establishes the dialog's own width, rather than the full terminal width.
  if (boundary) {
    const width = boundary[1]!.length;
    lines = lines.map((line, index) => index >= headerIndex ? clipDialogLine(line, width).trimEnd() : line);
  }
  const header = lines[headerIndex]?.trim() ?? '';
  const multiple = header.startsWith('←');
  if (multiple && !/\s+✔ Submit\s+→$/u.test(header)) return null;
  const tabText = multiple ? header.replace(/^←\s+/u, '').replace(/\s+✔ Submit\s+→$/u, '') : header;
  const tabs = headerIndex < 0 ? null : [...tabText.matchAll(/([☐☒])\s+([^☐☒]+?)(?=\s+[☐☒]|$)/gu)]
    .map((match) => ({ header: match[2]!.trim(), answered: match[1] === '☒' }));
  if (tabs && (tabs.length === 0 || (!multiple && tabs.length !== 1))) return null;
  const body = lines.slice(bodyStart);
  // Review answers are arbitrary text and may themselves contain numbered controls.
  const first = review
    ? body.reduce((last, line, index) => REVIEW_SUBMIT_ROW.test(line) ? index : last, -1)
    : body.findIndex((line) => ROW.test(line));
  if (first < 0) return null;
  // A preview is a second column inside the native dialog, not part of an option.
  // Restrict clipping to the choices: the question and footer still span the dialog.
  const box = / {2,}┌─+┐\s*$/u.exec(body[first]!);
  const previewColumn = !review && box ? stringWidth(body[first]!.slice(0, box.index + box[0].indexOf('┌'))) : null;
  let notesDraft = false;
  if (previewColumn !== null) {
    const end = body.findIndex((line, index) => index > first && RULE.test(line) && line.trim().length > 0);
    if (end < 0) return null;
    const rightColumn = body.slice(first, end).map((line) => line.slice(clipDialogLine(line, previewColumn).length).trim());
    const notesStart = rightColumn.findIndex((line) => line.startsWith('Notes: '));
    if (notesStart < 0) return null;
    // Notes can wrap or contain explicit newlines, even after placeholder-shaped text.
    notesDraft = rightColumn.slice(notesStart).filter(Boolean).join('\n') !== 'Notes: press n to add notes';
    for (let index = first; index < end; index += 1) body[index] = clipDialogLine(body[index]!, previewColumn).trimEnd();
  }

  const heading = body.slice(0, first).map((line) => line.replace(/^( ?)│/u, '$1 ')).filter((line) => line.trim().length > 0);
  const options: { label: string; focused: boolean; checked: boolean | null; continuationLines: string[] }[] = [];
  let labelColumn = 0;
  let nextFocused = false;
  let multiSelect = false;
  let lastNumber = 0;
  let optionsEnd = first;
  for (let index = first; index < body.length; index += 1) {
    const line = body[index]!;
    if (RULE.test(line) || line.trim() === '') {
      optionsEnd = index;
      if (RULE.test(line)) break;
      if (!review && options.length > 0) options[options.length - 1]!.continuationLines.push('');
      continue;
    }
    if (options.length > 0 && line.startsWith(' '.repeat(labelColumn))) {
      options[options.length - 1]!.continuationLines.push(line.slice(labelColumn));
      optionsEnd = index + 1;
      continue;
    }
    const match = ROW.exec(line);
    if (match) {
      if (Number(match[2]) !== lastNumber + 1) return null;
      lastNumber += 1;
      let label = match[3] ?? '';
      labelColumn = match[3] === undefined ? line.length + 1 : line.length - label.length;
      const checkbox = /^\[([ ✔✓xX])\](?:\s+(.*))?$/u.exec(label);
      let checked: boolean | null = null;
      if (checkbox) {
        multiSelect = true;
        checked = checkbox[1] !== ' ';
        label = checkbox[2] ?? '';
        labelColumn += 4;
      } else if (/ ✔$/u.test(label)) {
        checked = true;
        label = label.slice(0, -2);
      }
      if (previewColumn !== null) labelColumn -= 1;
      options.push({ label, focused: Boolean(match[1]), checked, continuationLines: [] });
    } else if (new RegExp(`^\\s*(${FOCUS})?\\s+Next$`, 'u').test(line)) {
      nextFocused = new RegExp(`^\\s*${FOCUS}`, 'u').test(line);
    } else if (!/^\s+\S/u.test(line) || new RegExp(`^\\s*${FOCUS}`, 'u').test(line)) {
      return null;
    }
    optionsEnd = index + 1;
  }
  if (options.filter((option) => option.focused).length + Number(nextFocused) !== 1) return null;
  const reviewAnswers: { question: string; answer: string }[] = [];
  if (review) {
    if ((tabs && !multiple) || options.length !== 2 || options[0]?.label !== 'Submit answers' || options[1]?.label !== 'Cancel') return null;
    if (body.slice(optionsEnd).some((line) => line.trim().length > 0)) return null;
    const firstEntry = reviewClipped ? heading.findIndex((line) => /^\s*●\s+/u.test(line)) : 1;
    // Only the top viewport fragment may be missing. Never skip an entry in the middle.
    if (reviewClipped && (firstEntry < 0 || heading.slice(0, firstEntry).some((line) => !/^\s{3,}\S/u.test(line)))) return null;
    const entries = heading.slice(firstEntry);
    if (entries.pop()?.trim() !== 'Ready to submit your answers?') return null;
    const incomplete = entries[0]?.trim() === '⚠ You have not answered all questions';
    if (incomplete) entries.shift();
    for (let index = 0; index < entries.length;) {
      const question = /^\s*●\s+(.+)$/u.exec(entries[index] ?? '');
      if (!question) return null;
      const questionLines = [question[1]!];
      index += 1;
      while (index < entries.length && /^\s{3,}\S/u.test(entries[index]!) && !/^\s*→/u.test(entries[index]!)) {
        questionLines.push(entries[index]!.trim());
        index += 1;
      }
      const answer = /^\s*→(?: (.*))?$/u.exec(entries[index] ?? '');
      if (!answer) return null;
      index += 1;
      const continuation: string[] = [];
      while (index < entries.length && entries[index]!.startsWith('   ') && !/^\s*●/u.test(entries[index]!)) {
        continuation.push(entries[index]!.slice(3));
        index += 1;
      }
      reviewAnswers.push({ question: questionLines.join('\n'), answer: [answer[1] ?? '', ...continuation].join('\n') });
    }
    if (tabs) {
      if (reviewAnswers.length !== tabs.filter((tab) => tab.answered).length) return null;
      if (incomplete !== (reviewAnswers.length < tabs.length)) return null;
    } else if (incomplete) return null;
  } else {
    if (heading.length === 0 || options.length === 0) return null;
    const footer = body.slice(optionsEnd).filter((line) => line.trim().length > 0);
    const hint = footer.slice(2).map((line) => line.trim()).join(' ');
    if (footer.length < 3 || !RULE.test(footer[0]!) || !(previewColumn !== null ? /^\s+Chat about this$/u : /^\s*\d+\. Chat about this$/u).test(footer[1]!) || !HINT.test(hint)) return null;
    // The editor owns navigation even when its text equals the idle notes hint.
    if (previewColumn !== null && hint.includes(' · ctrl+g to edit in ')) notesDraft = true;
    if (multiSelect && options.some((option) => option.checked === null)) return null;
    if (previewColumn === null) {
      const freeform = options.at(-1)!;
      const continuation = freeform.continuationLines;
      if (continuation.length > 0) freeform.label = [freeform.label, ...continuation].join('\n');
    }
  }
  return { kind: review ? 'review' : 'question', tabs, question: review ? null : heading.map((line) => line.trim()).join('\n'), multiSelect, nextFocused, freeformIndex: review || previewColumn !== null ? null : options.length - 1, notesDraft, options, reviewClipped, reviewAnswers };
}

/** One page identity for publication and navigation, independent of selection progress. */
export function resolveClaudeNativeQuestionScreen(
  presentation: ClaudeNativeQuestionPresentation,
  questions: readonly StructuredQuestionLike[],
): Readonly<{ kind: 'question'; questionIndex: number }> | Readonly<{ kind: 'review' }> | null {
  const result = normalizeStructuredQuestionDescriptors(questions);
  if (!result.ok) return null;
  const tabs = presentation.tabs;
  if (tabs && (result.questions.length !== tabs.length || !result.questions.every((question, index) => {
    const caption = tabs[index]!.header;
    const header = question.header ?? '';
    // Claude abbreviates inactive tabs at narrow widths. The visible question and
    // complete choices identify the current native page.
    return matchesClaudeNativeQuestionText(caption, header)
      || caption.endsWith('…') && normalized(header).startsWith(normalized(caption.slice(0, -1)));
  }))) return null;
  if (presentation.kind === 'review') {
    const answered = tabs ? result.questions.filter((_, index) => tabs[index]!.answered) : result.questions;
    const offset = presentation.reviewClipped ? answered.length - presentation.reviewAnswers.length : 0;
    const matches = offset >= 0 && presentation.reviewAnswers.length === answered.length - offset
      && answered.slice(offset).every((question, index) => matchesClaudeNativeQuestionText(presentation.reviewAnswers[index]?.question ?? '', question.question ?? ''));
    return matches ? { kind: 'review' } : null;
  }
  const matches = result.questions.flatMap((question, questionIndex) => {
    const hasFreeformRow = !isClaudeNativePreviewQuestion(questions[questionIndex]!);
    return question.multiSelect === presentation.multiSelect
      && (presentation.freeformIndex !== null) === hasFreeformRow
      && presentation.options.length === question.options.length + Number(hasFreeformRow)
      && question.options.every((option, index) => matchesOptionLabel(presentation.options[index]!, option.label))
      && matchesQuestionHeading(presentation, question.question ?? '') ? [questionIndex] : [];
  });
  return matches.length === 1 ? { kind: 'question', questionIndex: matches[0]! } : null;
}

export function matchesClaudeNativeQuestionScreen(
  presentation: ClaudeNativeQuestionPresentation,
  questions: readonly StructuredQuestionLike[],
): boolean {
  return resolveClaudeNativeQuestionScreen(presentation, questions) !== null;
}
