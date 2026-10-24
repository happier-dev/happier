import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { answerClaudeNativeQuestion, parseClaudeNativeQuestionScreen } from './nativeQuestion';
import { createFakeControlPort } from './fakeControlPort';
import { parseClaudeScreenState, resolveClaudeScreenInFlightSteerVeto } from './screenState';
import { wrapBracketedPaste } from '@/agent/runtime/terminal/injection/bracketedPaste';

const fixture = (name: string) => readFileSync(new URL(`./__fixtures__/claude-2.1.304-question-${name}.txt`, import.meta.url), 'utf8');
const single = fixture('single');
const multi = fixture('multi');
const size = fixture('size');
const review = fixture('review');
const unfilledReview = fixture('unfilled-review');
const partialReview = fixture('partial-review');
const freeform = fixture('freeform');
const idle = 'What would you like to work on?\n❯ ';
const questions = [{ question: 'Which probe color?', header: 'Header Color', options: [
  { label: 'Amber', description: 'Warm amber probe color.' },
  { label: 'Blue', description: 'Cool blue probe color.' },
], multiSelect: false }];
const multipleQuestions = [
  { question: 'Which probe fruits?', header: 'Fruits', multiSelect: true, options: [
    { label: 'Apple', description: 'Apple fruit.' },
    { label: 'Pear', description: 'Pear fruit.' },
    { label: 'Plum', description: 'Plum fruit.' },
  ] },
  { question: 'Which probe size?', header: 'Size', multiSelect: false, options: [
    { label: 'Small', description: 'Small size.' },
    { label: 'Large', description: 'Large size.' },
  ] },
];
const fruitAnswers = { 'Which probe fruits?': ['Apple', 'Pear'], 'Which probe size?': ['Large'] };
const focus = (screen: string, from: string, to: string) => screen.replace(`❯ ${from}`, `  ${from}`).replace(`  ${to}`, `❯ ${to}`);
const controls = { isCurrent: () => true, wait: async () => undefined, settleMs: 0, verifyPollIntervalMs: 1, verifyPollTimeoutMs: 2 };

describe('native Claude AskUserQuestion (2.1.304 captures)', () => {
  it('recognizes the live Claude 309 question above its trailing native session-title rule', () => {
    const screen = readFileSync(new URL('./__fixtures__/claude-2.1.309-question-session-title.txt', import.meta.url), 'utf8');
    expect(parseClaudeNativeQuestionScreen(screen)).toMatchObject({ kind: 'question', question: 'Which live Happier probe color?' });
    expect(parseClaudeScreenState(screen).unrecognizedConfirmationDialogVisible).toBe(false);
    expect(parseClaudeNativeQuestionScreen(`${screen}\nUnrecognized active dialog`)).toBeNull();
  });
  it('recognizes native questions, multi-select progress, review and inline freeform without reading transcript echoes', () => {
    expect(parseClaudeNativeQuestionScreen(single)).toMatchObject({ kind: 'question', question: 'Which probe color?' });
    expect(parseClaudeNativeQuestionScreen(multi)?.options.slice(0, 3)).toEqual([
      { label: 'Apple', focused: true, checked: false },
      { label: 'Pear', focused: false, checked: false },
      { label: 'Plum', focused: false, checked: false },
    ]);
    expect(parseClaudeNativeQuestionScreen(size)).toMatchObject({ kind: 'question', question: 'Which probe size?' });
    expect(parseClaudeNativeQuestionScreen(review)).toMatchObject({ kind: 'review' });
    expect(parseClaudeNativeQuestionScreen(unfilledReview)).toMatchObject({ kind: 'review', reviewAnswers: [] });
    expect(parseClaudeNativeQuestionScreen(partialReview)).toMatchObject({ kind: 'review', reviewAnswers: [{ question: 'Which probe size?', answer: 'Small' }] });
    expect(parseClaudeNativeQuestionScreen(freeform)?.options.at(-1)?.label).toBe('Otter freeform probe');
    expect(parseClaudeNativeQuestionScreen(`${single}\n${idle}`)).toBeNull();
    expect(parseClaudeNativeQuestionScreen(single.replaceAll('Which probe color?', 'Which probe\ncolor?'))).toBeNull();
    const state = parseClaudeScreenState(single);
    expect(state.unrecognizedConfirmationDialogVisible).toBe(false);
    expect(state.inputBoxInteractive).toBe(false);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('native_question');
  });

  it('submits only after exact provider question and choices match and final response disappears', async () => {
    const port = createFakeControlPort({ captures: [single, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions, answers: { 'Which probe color?': ['Amber'] } })).resolves.toEqual({ status: 'answered' });
    expect(port.sentKeys).toEqual(['Enter']);
    expect(port.sentLiteral).toEqual([]);
    const changed = createFakeControlPort({ captures: [single.replace('  2. Blue', '  2. Green')] });
    await expect(answerClaudeNativeQuestion({ ...controls, port: changed, questions, answers: { 'Which probe color?': ['Amber'] } })).resolves.toMatchObject({ status: 'failed' });
    expect(changed.sentKeys).toEqual([]);
  });

  it('checks missing selections, advances question pages, verifies every review answer, then submits once', async () => {
    const apple = multi.replace('1. [ ] Apple', '1. [✓] Apple');
    const pearFocus = focus(apple, '1. [✓] Apple', '2. [ ] Pear');
    const pear = pearFocus.replace('2. [ ] Pear', '2. [✓] Pear');
    const largeFocus = focus(size, '1. Small', '2. Large');
    const port = createFakeControlPort({ captures: [multi, apple, pearFocus, pear, size, largeFocus, review, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions: multipleQuestions, answers: fruitAnswers })).resolves.toEqual({ status: 'answered' });
    expect(port.sentKeys).toEqual(['Enter', 'ArrowDown', 'Enter', 'Tab', 'ArrowDown', 'Enter', 'Enter']);
  });

  it('never treats a tab transition or altered review as question completion', async () => {
    const port = createFakeControlPort({ captures: [review.replace('→ Apple, Pear', '→ Plum'), size, multi.replace('3. [ ] Plum', '3. [✔] Plum')] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions: multipleQuestions, answers: fruitAnswers })).resolves.toMatchObject({ status: 'failed' });
    expect(port.sentKeys).not.toEqual(expect.arrayContaining(['Escape']));
    expect(port.sentKeys.filter((key) => key === 'Enter')).toHaveLength(0);
  });

  it('does not replace a local draft or a conflicting checked choice', async () => {
    const draftQuestions = [{ question: 'Which probe animal?', header: 'Animal', options: ['Cat', 'Dog'] }];
    const port = createFakeControlPort({ captures: [freeform] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions: draftQuestions, answers: { 'Which probe animal?': ['Different draft'] } })).resolves.toMatchObject({ status: 'failed' });
    expect(port.sentKeys).toEqual([]);
    expect(port.sentLiteral).toEqual([]);
    const checked = createFakeControlPort({ captures: [multi.replace('3. [ ] Plum', '3. [✓] Plum')] });
    await expect(answerClaudeNativeQuestion({ ...controls, port: checked, questions: multipleQuestions, answers: fruitAnswers })).resolves.toMatchObject({ status: 'failed' });
    expect(checked.sentKeys).toEqual([]);
  });

  it('aborts after an occurrence is retired during navigation', async () => {
    let current = true;
    const port = createFakeControlPort({ captures: [single], onSendSpecialKey: () => { current = false; } });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions, answers: { 'Which probe color?': ['Blue'] }, isCurrent: () => current })).resolves.toMatchObject({ status: 'failed' });
    expect(port.sentKeys).toEqual(['ArrowDown']);
  });

  it('types into the focused native freeform row and verifies it before submitting', async () => {
    const draftQuestions = [{ question: 'Which probe animal?', header: 'Animal', options: ['Cat', 'Dog'] }];
    const empty = freeform.replace('Otter freeform probe', 'Type something.');
    const port = createFakeControlPort({ captures: [empty, freeform, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions: draftQuestions, answers: { 'Which probe animal?': ['Otter freeform probe'] } })).resolves.toEqual({ status: 'answered' });
    expect(port.sentLiteral).toEqual(['Otter freeform probe']);
    expect(port.sentKeys).toEqual(['Enter']);
  });

  it('retains compatible checked selections while native typing auto-checks multi-select freeform', async () => {
    const emptyDraft = focus(multi.replace('1. [ ] Apple', '1. [✔] Apple'), '1. [✔] Apple', '4. [ ] Type something');
    const filled = emptyDraft.replace('4. [ ] Type something', '4. [✔] Berry draft');
    const port = createFakeControlPort({ captures: [emptyDraft, filled, size, focus(size, '1. Small', '2. Large'), review.replace('→ Apple, Pear', '→ Apple, Berry draft'), idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions: multipleQuestions, answers: { ...fruitAnswers, 'Which probe fruits?': ['Apple', 'Berry draft'] } })).resolves.toEqual({ status: 'answered' });
    expect(port.sentLiteral).toEqual(['Berry draft']);
    expect(port.sentKeys).toEqual(['Tab', 'ArrowDown', 'Enter', 'Enter']);
  });

  it('does not mistake an incomplete redraw after final Enter for completion', async () => {
    const port = createFakeControlPort({ captures: [single, 'redrawing'] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions, answers: { 'Which probe color?': ['Amber'] } })).resolves.toEqual({ status: 'failed', reason: 'native_question_completion_unverified' });
  });

  it('revisits earlier questions when the terminal user has navigated ahead before answering in the app', async () => {
    const apple = multi.replace('1. [ ] Apple', '1. [✔] Apple');
    const pearFocus = focus(apple, '1. [✔] Apple', '2. [ ] Pear');
    const pear = pearFocus.replace('2. [ ] Pear', '2. [✔] Pear');
    const port = createFakeControlPort({ captures: [size, multi, apple, pearFocus, pear, size, focus(size, '1. Small', '2. Large'), review, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions: multipleQuestions, answers: fruitAnswers })).resolves.toEqual({ status: 'answered' });
    expect(port.sentKeys[0]).toBe('ShiftTab');
    expect(port.sentKeys.filter((key) => key === 'Enter')).toHaveLength(4);
  });

  it('can fill an unanswered form after the terminal user has browsed to Submit', async () => {
    const apple = multi.replace('1. [ ] Apple', '1. [✔] Apple');
    const pearFocus = focus(apple, '1. [✔] Apple', '2. [ ] Pear');
    const pear = pearFocus.replace('2. [ ] Pear', '2. [✔] Pear');
    const port = createFakeControlPort({ captures: [unfilledReview, size, multi, apple, pearFocus, pear, size, focus(size, '1. Small', '2. Large'), review, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions: multipleQuestions, answers: fruitAnswers })).resolves.toEqual({ status: 'answered' });
    expect(port.sentKeys.slice(0, 2)).toEqual(['ShiftTab', 'ShiftTab']);
  });

  it('does not submit the native empty-row placeholder as a freeform answer', async () => {
    const draftQuestions = [{ question: 'Which probe animal?', header: 'Animal', options: ['Cat', 'Dog'] }];
    const empty = freeform.replace('Otter freeform probe', 'Type something.');
    const port = createFakeControlPort({ captures: [empty, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions: draftQuestions, answers: { 'Which probe animal?': ['Type something.'] } })).resolves.toMatchObject({ status: 'failed' });
    expect(port.sentKeys).toEqual([]);
  });

  it('preserves multiline Unicode freeform using canonical bracketed paste and verifies all visible lines', async () => {
    const filled = fixture('multiline');
    const text = 'owned canonical first LF\nowned canonical second LF — 雪 🦦';
    const nativeQuestions = [{ question: 'Which comma probe?', header: 'Comma', options: ['Alpha, beta', '雪 🦦'] }];
    const empty = filled.replace('owned canonical first LF\n     owned canonical second LF — 雪 🦦', 'Type something.');
    expect(parseClaudeNativeQuestionScreen(filled)?.options.at(-1)?.label).toBe(text);
    const port = createFakeControlPort({ captures: [empty, filled, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions: nativeQuestions, answers: { 'Which comma probe?': [text] } })).resolves.toEqual({ status: 'answered' });
    expect(port.sentRaw).toEqual([wrapBracketedPaste(text)]);
    expect(port.sentLiteral).toEqual([]);
    expect(port.sentKeys).toEqual(['Enter']);
  });

  it('verifies owned wrapped text but preserves an ambiguous preexisting multiline draft', async () => {
    const filled = fixture('wrapped');
    const text = Array.from({ length: 32 }, (_, index) => `word${String(index + 1).padStart(2, '0')}`).join(' ');
    const nativeQuestions = [{ question: 'Which comma probe?', header: 'Comma', options: ['Alpha, beta', '雪 🦦'] }];
    const shown = parseClaudeNativeQuestionScreen(filled)!.options.at(-1)!.label;
    const empty = filled.replace(shown.split('\n').join('\n     '), 'Type something.');
    const own = createFakeControlPort({ captures: [empty, filled, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port: own, questions: nativeQuestions, answers: { 'Which comma probe?': [text] } })).resolves.toEqual({ status: 'answered' });
    expect(own.sentLiteral).toEqual([text]);
    const local = createFakeControlPort({ captures: [filled] });
    await expect(answerClaudeNativeQuestion({ ...controls, port: local, questions: nativeQuestions, answers: { 'Which comma probe?': [shown] } })).resolves.toEqual({ status: 'failed', reason: 'local_answer_conflict' });
    expect(local.sentKeys).toEqual([]);
    expect(local.sentLiteral).toEqual([]);
  });

  it('uses exact provider answer evidence within the submission budget when the caller supplies it', async () => {
    let current = true;
    let checks = 0;
    const matched = createFakeControlPort({ captures: [single], onSendSpecialKey: () => { current = false; } });
    await expect(answerClaudeNativeQuestion({ ...controls, port: matched, questions, answers: { 'Which probe color?': ['Amber'] },
      isCurrent: () => current, verifyApplied: () => ++checks === 1 ? 'pending' : 'matched',
    })).resolves.toEqual({ status: 'answered' });
    expect(checks).toBe(2);
    const mismatched = createFakeControlPort({ captures: [single, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port: mismatched, questions, answers: { 'Which probe color?': ['Amber'] }, verifyApplied: () => 'mismatched' })).resolves.toEqual({ status: 'failed', reason: 'native_answer_mismatch' });
    const pending = createFakeControlPort({ captures: [single], onSendSpecialKey: () => { current = false; } });
    current = true;
    await expect(answerClaudeNativeQuestion({ ...controls, port: pending, questions, answers: { 'Which probe color?': ['Amber'] }, isCurrent: () => current, verifyApplied: () => 'pending' })).resolves.toEqual({ status: 'failed', reason: 'native_answer_unverified' });
  });

  it('leaves the multiline editor through Next and verifies complete multiline review before final Submit', async () => {
    const next = fixture('multiline-next');
    const filled = next.replace('  3. [✔]', '❯ 3. [✔]').replace('❯    Next', '     Next');
    const text = 'owned canonical first LF\nowned canonical second LF — 雪 🦦';
    const empty = filled.replace('☒ Multi', '☐ Multi').replace('[✔] owned canonical first LF\n         owned canonical second LF — 雪 🦦', '[ ] Type something');
    const unicode = fixture('multiline-unicode');
    const comma = unicode.replace('☒ Multi  ☒ Comma', '☒ Multi  ☐ Comma').replace('Which Unicode value?\n', 'Which comma value?\n')
      .replace('1. 雪 🦦\n', '1. Alpha, beta\n');
    const completeReview = fixture('multiline-review');
    const nativeQuestions = [
      { question: 'Which multiline value?', header: 'Multi', options: ['A', 'B'], multiSelect: true },
      { question: 'Which comma value?', header: 'Comma', options: ['Alpha, beta', 'Plain'] },
      { question: 'Which Unicode value?', header: 'Unicode', options: ['雪 🦦', 'Plain'] },
    ];
    expect(parseClaudeNativeQuestionScreen(completeReview)?.reviewAnswers[0]?.answer).toBe(text);
    const port = createFakeControlPort({ captures: [empty, filled, next, comma, unicode, completeReview, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions: nativeQuestions, answers: {
      'Which multiline value?': [text], 'Which comma value?': ['Alpha, beta'], 'Which Unicode value?': ['雪 🦦'],
    } })).resolves.toEqual({ status: 'answered' });
    expect(port.sentRaw).toEqual([wrapBracketedPaste(text)]);
    expect(port.sentKeys).toEqual(['Tab', 'Enter', 'Enter', 'Enter', 'Enter']);
  });
  it('preserves leading and trailing LF, blank paragraphs, and TAB through owned bracketed paste', async () => {
    const filled = fixture('blank-lines');
    const text = '\nfirst paragraph\n\nsecond paragraph\t雪 🦦\n';
    const nativeQuestions = [{ question: 'Which blank-lines probe?', header: 'Blank', options: ['Alpha', 'Beta'] }];
    const empty = filled.replace('❯ 3.\n     first paragraph\n\n     second paragraph        雪 🦦\n\n', '❯ 3. Type something.\n');
    const port = createFakeControlPort({ captures: [empty, filled, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions: nativeQuestions, answers: { 'Which blank-lines probe?': [text] } })).resolves.toEqual({ status: 'answered' });
    expect(port.sentRaw).toEqual([wrapBracketedPaste(text)]);
    expect(port.sentKeys).toEqual(['Enter']);
  });
});
