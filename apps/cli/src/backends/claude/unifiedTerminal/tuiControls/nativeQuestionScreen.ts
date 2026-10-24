import { normalizeStructuredQuestionDescriptors, type StructuredQuestionLike } from '@happier-dev/protocol';

import { readClaudeNativeDialogScreenLines } from './nativeScreenCapture';

export type ClaudeNativeQuestionPresentation = Readonly<{
  kind: 'question' | 'review';
  tabs: readonly Readonly<{ header: string; answered: boolean }>[];
  question: string | null;
  multiSelect: boolean;
  nextFocused: boolean;
  options: readonly Readonly<{ label: string; focused: boolean; checked: boolean | null }>[];
  reviewAnswers: readonly Readonly<{ question: string; answer: string }>[];
}>;

const FOCUS = '[>›❯]';
const ROW = new RegExp(`^\\s*(${FOCUS})?\\s*(\\d+)\\.(?:\\s+(.+?))?\\s*$`, 'u');
const RULE = /^[\s─━]+$/u;
const HEADER = /^\s*(?:←\s+)?[☐☒]\s+.+?\s*$/u;
const HINT = /^Enter to select · (?:↑\/↓ to navigate|Tab\/Arrow keys to navigate)(?: · ctrl\+g to edit in .+)? · Esc to cancel$/u;

function normalized(value: string): string {
  return value.trim().replace(/\s+/gu, ' ');
}

/** Native Claude Code 2.1.304 presentation, characterized against real tmux captures. */
export function parseClaudeNativeQuestionScreen(rawText: string): ClaudeNativeQuestionPresentation | null {
  const lines = readClaudeNativeDialogScreenLines(rawText);
  let headerIndex = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (HEADER.test(lines[index]!)) { headerIndex = index; break; }
  }
  if (headerIndex < 0 || !RULE.test(lines[headerIndex - 1] ?? '')) return null;
  const header = lines[headerIndex]!.trim();
  const multiple = header.startsWith('←');
  if (multiple && !/\s+✔ Submit\s+→$/u.test(header)) return null;
  const tabText = multiple ? header.replace(/^←\s+/u, '').replace(/\s+✔ Submit\s+→$/u, '') : header;
  const tabs = [...tabText.matchAll(/([☐☒])\s+([^☐☒]+?)(?=\s+[☐☒]|$)/gu)]
    .map((match) => ({ header: match[2]!.trim(), answered: match[1] === '☒' }));
  if (tabs.length === 0 || (!multiple && tabs.length !== 1)) return null;
  const body = lines.slice(headerIndex + 1);
  const review = body.find((line) => line.trim().length > 0)?.trim() === 'Review your answers';
  const first = body.findIndex((line) => (
    review ? new RegExp(`^\\s*${FOCUS}?\\s*1\\. Submit answers$`, 'u').test(line) : ROW.test(line)
  ));
  if (first < 0) return null;
  const heading = body.slice(0, first).filter((line) => line.trim().length > 0);
  const options: { label: string; focused: boolean; checked: boolean | null }[] = [];
  const continuationLines: string[][] = [];
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
      if (!review && options.length > 0) continuationLines[options.length - 1]!.push('');
      continue;
    }
    if (options.length > 0 && line.startsWith(' '.repeat(labelColumn))) {
      continuationLines[options.length - 1]!.push(line.slice(labelColumn));
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
      options.push({ label, focused: Boolean(match[1]), checked });
      continuationLines.push([]);
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
    if (!multiple || options.length !== 2 || options[0]?.label !== 'Submit answers' || options[1]?.label !== 'Cancel') return null;
    if (body.slice(optionsEnd).some((line) => line.trim().length > 0)) return null;
    const entries = heading.slice(1);
    if (entries.pop()?.trim() !== 'Ready to submit your answers?') return null;
    const incomplete = entries[0]?.trim() === '⚠ You have not answered all questions';
    if (incomplete) entries.shift();
    for (let index = 0; index < entries.length;) {
      const question = /^\s*●\s+(.+)$/u.exec(entries[index] ?? '');
      const answer = /^\s*→(?: (.*))?$/u.exec(entries[index + 1] ?? '');
      if (!question || !answer) return null;
      index += 2;
      const continuation: string[] = [];
      while (index < entries.length && entries[index]!.startsWith('   ')) {
        continuation.push(entries[index]!.slice(3));
        index += 1;
      }
      reviewAnswers.push({ question: question[1]!, answer: [answer[1] ?? '', ...continuation].join('\n') });
    }
    if (reviewAnswers.length !== tabs.filter((tab) => tab.answered).length) return null;
    if (incomplete !== (reviewAnswers.length < tabs.length)) return null;
  } else {
    // Unknown/wrapped layouts stay blocked by the generic screen owner rather than guessed.
    if (heading.length !== 1 || options.length === 0) return null;
    const footer = body.slice(optionsEnd).filter((line) => line.trim().length > 0);
    if (footer.length !== 3 || !RULE.test(footer[0]!) || !/^\s*\d+\. Chat about this$/u.test(footer[1]!) || !HINT.test(footer[2]!)) return null;
    if (multiSelect && options.some((option) => option.checked === null)) return null;
    const freeform = options.at(-1)!;
    const continuation = continuationLines.at(-1)!;
    if (continuation.length > 0) freeform.label = [freeform.label, ...continuation].join('\n');
  }
  return { kind: review ? 'review' : 'question', tabs, question: review ? null : heading[0]!.trim(), multiSelect, nextFocused, options, reviewAnswers };
}

/** Correlates a native presentation with hook-owned questions, independent of selection progress. */
export function matchesClaudeNativeQuestionScreen(
  presentation: ClaudeNativeQuestionPresentation,
  questions: readonly StructuredQuestionLike[],
): boolean {
  const result = normalizeStructuredQuestionDescriptors(questions);
  if (!result.ok || result.questions.length !== presentation.tabs.length) return false;
  if (!result.questions.every((question, index) => normalized(question.header ?? '') === normalized(presentation.tabs[index]!.header))) return false;
  if (presentation.kind === 'review') {
    const answered = result.questions.filter((_, index) => presentation.tabs[index]!.answered);
    return answered.length === presentation.reviewAnswers.length
      && answered.every((question, index) => normalized(question.question ?? '') === normalized(presentation.reviewAnswers[index]?.question ?? ''));
  }
  const matches = result.questions.filter((question) => normalized(question.question ?? '') === normalized(presentation.question ?? ''));
  if (matches.length !== 1) return false;
  const question = matches[0]!;
  return question.multiSelect === presentation.multiSelect
    && presentation.options.length === question.options.length + 1
    && question.options.every((option, index) => option.label === presentation.options[index]!.label);
}
