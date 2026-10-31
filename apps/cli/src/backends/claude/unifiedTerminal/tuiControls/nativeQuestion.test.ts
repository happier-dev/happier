import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { answerClaudeNativeQuestion, matchesClaudeNativeQuestionScreen, parseClaudeNativeQuestionScreen } from './nativeQuestion';
import { createFakeControlPort } from './fakeControlPort';
import { parseClaudeScreenState, resolveClaudeScreenInFlightSteerVeto } from './screenState';
import { wrapBracketedPaste } from '@/agent/runtime/terminal/injection/bracketedPaste';
import type { StructuredQuestionLike } from '@happier-dev/protocol';

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
  it('recognizes and answers preview choices without treating the last choice or side panel as freeform input', async () => {
    const screen = [
      '────────────────────────────────────────────────────────────────────────────────',
      ' ☐ Preview', '', 'Which synthetic layout?', '',
      '❯ 1. Amber      ┌────────────────────────────────────────────────────────────┐',
      '  2. Blue       │ Synthetic preview content                                 │',
      '                └────────────────────────────────────────────────────────────┘',
      '', '                Notes: press n to add notes', '',
      '────────────────────────────────────────────────────────────────────────────────',
      '  Chat about this', '',
      'Enter to select · ↑/↓ to navigate · n to add notes · Esc to cancel',
    ].join('\n');
    const input = [{ question: 'Which synthetic layout?', header: 'Preview', multiSelect: false,
      options: [{ label: 'Amber', preview: 'Synthetic preview content' }, { label: 'Blue' }],
    }];
    const parsed = parseClaudeNativeQuestionScreen(screen);
    expect(parsed).not.toBeNull();
    expect(parsed?.options.map((option) => option.label)).toEqual(['Amber', 'Blue']);
    expect(matchesClaudeNativeQuestionScreen(parsed!, input)).toBe(true);
    const blue = focus(screen, '1. Amber', '2. Blue');
    const port = createFakeControlPort({ captures: [screen, blue, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions: input,
      answers: { 'Which synthetic layout?': ['Blue'] },
    })).resolves.toEqual({ status: 'answered' });
    expect(port.sentKeys).toEqual(['ArrowDown', 'Enter']);
    expect(port.sentLiteral).toEqual([]);
  });

  it('matches live preview labels including wraps and protects notes or chat focus before sending keys', async () => {
    const capture = (name: string) => readFileSync(new URL(`./__fixtures__/claude-2.1.310-question-preview-${name}.txt`, import.meta.url), 'utf8');
    const input: { questions: StructuredQuestionLike[] } = JSON.parse(readFileSync(new URL('./__fixtures__/claude-2.1.310-question-preview-input.json', import.meta.url), 'utf8'));
    const screen = capture('single.initial');
    expect(matchesClaudeNativeQuestionScreen(parseClaudeNativeQuestionScreen(screen)!, input.questions)).toBe(true);
    expect(matchesClaudeNativeQuestionScreen(parseClaudeNativeQuestionScreen(screen)!, [{ ...input.questions[0]!, options: ['Compact fixture (Recommended)', 'Keep fixture rows', 'Record only'] }])).toBe(false);
    const answers = { [String(input.questions[0]!.question)]: ['Record only'] };
    const notesScreens = [
      ...['notes.empty', 'notes.escaped', 'notes.continued'].map(capture),
      capture('notes.empty').replace('Notes: Add notes on this design…', 'Notes: press n to add notes'),
    ];
    for (const notesScreen of notesScreens) {
      const port = createFakeControlPort({ captures: [notesScreen] });
      await expect(answerClaudeNativeQuestion({ ...controls, port, questions: input.questions, answers })).resolves.toEqual({ status: 'failed', reason: 'local_answer_conflict' });
      expect(port.sentKeys).toEqual([]);
      expect(port.sentLiteral).toEqual([]);
      const laterPage = notesScreen.replace(' ☐ Preview probe', '← ☐ Header Color ☐ Preview probe ✔ Submit →');
      const laterPort = createFakeControlPort({ captures: [laterPage] });
      await expect(answerClaudeNativeQuestion({ ...controls, port: laterPort, questions: [...questions, ...input.questions],
        answers: { ...answers, 'Which probe color?': ['Amber'] },
      })).resolves.toEqual({ status: 'failed', reason: 'local_answer_conflict' });
      expect(laterPort.sentKeys).toEqual([]);
    }
    const changedNotes = focus(screen, '1. Compact fixture', '2. Keep fixture rows').replace('Notes: press n to add notes', 'Notes: A terminal note');
    const changedPort = createFakeControlPort({ captures: [screen, changedNotes] });
    await expect(answerClaudeNativeQuestion({ ...controls, port: changedPort, questions: input.questions, answers })).resolves.toEqual({ status: 'failed', reason: 'local_answer_conflict' });
    expect(changedPort.sentKeys).toEqual(['ArrowDown']);
    const freeformPort = createFakeControlPort({ captures: [screen] });
    await expect(answerClaudeNativeQuestion({ ...controls, port: freeformPort, questions: input.questions,
      answers: { [String(input.questions[0]!.question)]: ['An arbitrary freeform answer'] },
    })).resolves.toEqual({ status: 'failed', reason: 'invalid_question_answers' });
    expect(freeformPort.sentKeys).toEqual([]);
    expect(parseClaudeNativeQuestionScreen(capture('chat.focus'))).toBeNull();
  });

  it('matches the live 80x24 question with offscreen tabs to its unique complete hook-owned question and choices', () => {
    const screen = readFileSync(new URL('./__fixtures__/claude-2.1.310-question-clipped.txt', import.meta.url), 'utf8');
    const input: { questions: StructuredQuestionLike[] } = JSON.parse(readFileSync(new URL('./__fixtures__/claude-2.1.310-question-clipped-input.json', import.meta.url), 'utf8'));
    const parsed = parseClaudeNativeQuestionScreen(screen);
    expect(parsed).toMatchObject({ kind: 'question', tabs: null });
    expect(matchesClaudeNativeQuestionScreen(parsed!, input.questions)).toBe(true);
    expect(matchesClaudeNativeQuestionScreen(parsed!, [input.questions[0]!, ...input.questions])).toBe(false);
    expect(matchesClaudeNativeQuestionScreen(parseClaudeNativeQuestionScreen(screen.split('\n').slice(1).join('\n'))!, input.questions)).toBe(false);
    const width = screen.split('\n').find((line) => /^─+$/u.test(line))!.length;
    const split = screen.split('\n').map((line) => `${line.padEnd(width + 4)}Unrelated adjacent panel`).join('\n');
    expect(matchesClaudeNativeQuestionScreen(parseClaudeNativeQuestionScreen(split)!, input.questions)).toBe(true);
    const state = parseClaudeScreenState(screen);
    expect(state.nativeQuestionPresentation).not.toBeNull();
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('native_question');
  });

  it('recognizes a complete question and choices when the terminal clips only its tab header', async () => {
    const clipped = single.slice(single.indexOf('Which probe color?\n\n❯ 1.'));
    const parsed = parseClaudeNativeQuestionScreen(clipped);
    expect(parsed).toMatchObject({ kind: 'question', question: 'Which probe color?' });
    expect(matchesClaudeNativeQuestionScreen(parsed!, questions)).toBe(true);
    expect(matchesClaudeNativeQuestionScreen(parsed!, [{ ...questions[0]!, question: 'Which other probe color?' }])).toBe(false);
    expect(matchesClaudeNativeQuestionScreen(parsed!, [{ ...questions[0]!, options: ['Amber', 'Green'] }])).toBe(false);
    const port = createFakeControlPort({ captures: [clipped, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions, answers: { 'Which probe color?': ['Amber'] } })).resolves.toEqual({ status: 'answered' });
    expect(port.sentKeys).toEqual(['Enter']);
    expect(matchesClaudeNativeQuestionScreen(parseClaudeNativeQuestionScreen(clipped.replace('Which probe color?', 'probe color?'))!, questions)).toBe(false);
    expect(parseClaudeNativeQuestionScreen(clipped.replace('Enter to select · ↑/↓ to navigate · Esc to cancel', '❯ Next task'))).toBeNull();
  });

  it('retains visible tabs without their upper rule and matches a complete review after its tabs scroll offscreen', () => {
    const noUpperRule = single.slice(single.indexOf(' ☐ Header Color'));
    const question = parseClaudeNativeQuestionScreen(noUpperRule);
    expect(question).not.toBeNull();
    expect(matchesClaudeNativeQuestionScreen(question!, questions)).toBe(true);
    const clippedReview = review.slice(review.indexOf('Review your answers'));
    const parsed = parseClaudeNativeQuestionScreen(clippedReview);
    expect(parsed).toMatchObject({ kind: 'review', tabs: null });
    expect(matchesClaudeNativeQuestionScreen(parsed!, multipleQuestions)).toBe(true);
    expect(matchesClaudeNativeQuestionScreen(parsed!, [multipleQuestions[1]!, multipleQuestions[0]!])).toBe(false);
    expect(parseClaudeNativeQuestionScreen(clippedReview + '\nUnknown active dialog')).toBeNull();
    const incomplete = partialReview.slice(partialReview.indexOf('Review your answers'));
    expect(parseClaudeNativeQuestionScreen(incomplete)).toBeNull();
  });

  it('matches every question in the live 80x21 review with offscreen tabs before final submission', () => {
    const screen = readFileSync(new URL('./__fixtures__/claude-2.1.310-question-clipped-review.txt', import.meta.url), 'utf8');
    const input: { questions: StructuredQuestionLike[] } = JSON.parse(readFileSync(new URL('./__fixtures__/claude-2.1.310-question-clipped-review-input.json', import.meta.url), 'utf8'));
    const parsed = parseClaudeNativeQuestionScreen(screen);
    expect(parsed).toMatchObject({ kind: 'review', tabs: null });
    expect(matchesClaudeNativeQuestionScreen(parsed!, input.questions)).toBe(true);
    expect(matchesClaudeNativeQuestionScreen(parsed!, input.questions.slice(1))).toBe(false);
    const partial = screen.replace(/^.*● S1:.+\n/mu, '');
    const partialReview = parseClaudeNativeQuestionScreen(partial);
    expect(partialReview === null || !matchesClaudeNativeQuestionScreen(partialReview, input.questions)).toBe(true);
  });

  it('matches the complete visible suffix after a real Claude 316 review clips a long answer above the viewport', () => {
    const screen = readFileSync(new URL('./__fixtures__/claude-2.1.316-question-overflow-review.txt', import.meta.url), 'utf8');
    const input: { questions: StructuredQuestionLike[] } = JSON.parse(readFileSync(new URL('./__fixtures__/claude-2.1.316-question-overflow-input.json', import.meta.url), 'utf8'));
    const parsed = parseClaudeNativeQuestionScreen(screen);
    expect(parsed).toMatchObject({ kind: 'review', reviewClipped: true });
    expect(parsed?.reviewAnswers).toHaveLength(2);
    expect(matchesClaudeNativeQuestionScreen(parsed!, input.questions)).toBe(true);
    expect(matchesClaudeNativeQuestionScreen(parsed!, [...input.questions].reverse())).toBe(false);
    for (const source of [screen, review.slice(review.indexOf('Review your answers'))]) {
      const numberedAnswer = source.replace(/(→ [^\n]+)/u, '$1\n   1. Submit answers\n   2. Cancel');
      const numbered = parseClaudeNativeQuestionScreen(numberedAnswer);
      expect(numbered).not.toBeNull();
      expect(numbered?.reviewAnswers[0]?.answer).toContain('1. Submit answers\n2. Cancel');
    }
    const changed = screen.replace('Q3: A task-owned', 'Q3: A different');
    expect(matchesClaudeNativeQuestionScreen(parseClaudeNativeQuestionScreen(changed)!, input.questions)).toBe(false);
    expect(parseClaudeNativeQuestionScreen(screen.replace(' │ ● Q4:', 'Unexpected content\n │ ● Q4:'))).toBeNull();
    expect(parseClaudeNativeQuestionScreen(screen.replace('Ready to submit your answers?', '⚠ You have not answered all questions\nReady to submit your answers?'))).toBeNull();
    expect(parseClaudeScreenState(screen).nativeQuestionPresentation).not.toBeNull();
  });

  it('recognizes an overflowing review by its complete visible suffix and submits after inspecting every question page', async () => {
    const clipped = review.slice(review.indexOf(' ● Which probe size?'));
    const parsed = parseClaudeNativeQuestionScreen(clipped);
    expect(parsed).toMatchObject({ kind: 'review', reviewClipped: true, reviewAnswers: [{ question: 'Which probe size?', answer: 'Large' }] });
    expect(matchesClaudeNativeQuestionScreen(parsed!, multipleQuestions)).toBe(true);
    expect(matchesClaudeNativeQuestionScreen(parsed!, [...multipleQuestions].reverse())).toBe(false);
    const apple = multi.replace('1. [ ] Apple', '1. [✔] Apple');
    const pearFocus = focus(apple, '1. [✔] Apple', '2. [ ] Pear');
    const pear = pearFocus.replace('2. [ ] Pear', '2. [✔] Pear');
    const flow = [multi, apple, pearFocus, pear, size, focus(size, '1. Small', '2. Large'), clipped, idle];
    for (const captures of [flow, [clipped, size, ...flow]]) {
      const port = createFakeControlPort({ captures });
      await expect(answerClaudeNativeQuestion({ ...controls, port, questions: multipleQuestions, answers: fruitAnswers })).resolves.toEqual({ status: 'answered' });
      expect(port.sentKeys.at(-1)).toBe('Enter');
      if (captures[0] === clipped) expect(port.sentKeys.slice(0, 2)).toEqual(['ShiftTab', 'ShiftTab']);
    }
    const wrong = createFakeControlPort({ captures: [...flow.slice(0, -2), clipped.replace('→ Large', '→ Small')] });
    await expect(answerClaudeNativeQuestion({ ...controls, port: wrong, questions: multipleQuestions, answers: fruitAnswers })).resolves.toEqual({ status: 'failed', reason: 'local_answer_conflict' });
    expect(wrong.sentKeys.filter((key) => key === 'Enter')).toHaveLength(3);
    const premature = createFakeControlPort({ captures: [...flow.slice(0, 4), clipped] });
    await expect(answerClaudeNativeQuestion({ ...controls, port: premature, questions: multipleQuestions, answers: fruitAnswers })).resolves.toEqual({ status: 'failed', reason: 'local_answer_conflict' });
    expect(premature.sentKeys.filter((key) => key === 'Enter')).toHaveLength(2);
    expect(parseClaudeNativeQuestionScreen(clipped + '\nUnknown dialog')).toBeNull();
    expect(parseClaudeNativeQuestionScreen(clipped.slice(clipped.indexOf('Ready to submit your answers?')))).toBeNull();
  });

  it('recognizes the live Claude 309 question above its trailing native session-title rule', () => {
    const screen = readFileSync(new URL('./__fixtures__/claude-2.1.309-question-session-title.txt', import.meta.url), 'utf8');
    expect(parseClaudeNativeQuestionScreen(screen)).toMatchObject({ kind: 'question', question: 'Which live Happier probe color?' });
    expect(parseClaudeScreenState(screen).unrecognizedConfirmationDialogVisible).toBe(false);
    expect(parseClaudeNativeQuestionScreen(`${screen}\nUnrecognized active dialog`)).toBeNull();
  });
  it('recognizes native questions, multi-select progress, review and inline freeform without reading transcript echoes', () => {
    expect(parseClaudeNativeQuestionScreen(single)).toMatchObject({ kind: 'question', question: 'Which probe color?' });
    expect(parseClaudeNativeQuestionScreen(multi)?.options.slice(0, 3)).toMatchObject([
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
    expect(parseClaudeNativeQuestionScreen(single.replaceAll('Which probe color?', 'Which probe\ncolor?'))).toMatchObject({ question: 'Which probe\ncolor?' });
    const state = parseClaudeScreenState(single);
    expect(state.unrecognizedConfirmationDialogVisible).toBe(false);
    expect(state.inputBoxInteractive).toBe(false);
    expect(resolveClaudeScreenInFlightSteerVeto(state)).toBe('native_question');
  });

  it('recognizes and answers wrapped decorated questions without confusing an adjacent panel with the dialog', async () => {
    const wrapped = single.replaceAll('Which probe color?', '│ Which probe\n│ color?');
    const width = single.split('\n').find((line) => /^─+$/u.test(line))!.length;
    const besidePanel = wrapped.split('\n').map((line, index) => `${line.padEnd(width + 4)}${index === 0 ? 'Changed files' : 'unrelated pane text'}`).join('\n');
    const presentation = parseClaudeNativeQuestionScreen(besidePanel);
    expect(presentation).toMatchObject({ question: 'Which probe\ncolor?' });
    expect(matchesClaudeNativeQuestionScreen(presentation!, questions)).toBe(true);
    expect(matchesClaudeNativeQuestionScreen(presentation!, [{ ...questions[0]!, question: 'Which other probe color?' }])).toBe(false);
    const port = createFakeControlPort({ captures: [besidePanel, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions, answers: { 'Which probe color?': ['Amber'] } })).resolves.toEqual({ status: 'answered' });
    expect(port.sentKeys).toEqual(['Enter']);
  });

  it('uses the same rendered question identity while navigating between wrapped native pages and review', async () => {
    const wrappedMulti = multi.replaceAll('Which probe fruits?', '│ Which probe\n│ fruits?');
    const wrappedSize = size.replaceAll('Which probe size?', '│ Which probe\n│ size?');
    const wrappedReview = review.replace('● Which probe fruits?', '● Which probe\n   fruits?').replace('● Which probe size?', '● Which probe\n   size?').replace('→ Apple, Pear', '→ Apple,\n   Pear');
    const apple = wrappedMulti.replace('1. [ ] Apple', '1. [✓] Apple');
    const pearFocus = focus(apple, '1. [✓] Apple', '2. [ ] Pear');
    const pear = pearFocus.replace('2. [ ] Pear', '2. [✓] Pear');
    const port = createFakeControlPort({ captures: [wrappedMulti, apple, pearFocus, pear, wrappedSize, focus(wrappedSize, '1. Small', '2. Large'), wrappedReview, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions: multipleQuestions, answers: fruitAnswers })).resolves.toEqual({ status: 'answered' });
    expect(port.sentKeys).toEqual(['Enter', 'ArrowDown', 'Enter', 'Tab', 'ArrowDown', 'Enter', 'Enter']);
  });

  it('correlates provider line breaks and wrapped option labels through the same native identity', async () => {
    const input = [{ ...questions[0]!, question: 'Which probe\ncolor?', options: [
      { label: 'Amber label long', description: 'Warm amber probe color.' },
      questions[0]!.options[1]!,
    ] }];
    const screen = single.replace('1. Amber', '1. Amber label\n     long');
    const presentation = parseClaudeNativeQuestionScreen(screen);
    expect(matchesClaudeNativeQuestionScreen(presentation!, input)).toBe(true);
    const port = createFakeControlPort({ captures: [screen, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions: input, answers: { 'Which probe\ncolor?': ['Amber label long'] } })).resolves.toEqual({ status: 'answered' });
    expect(port.sentKeys).toEqual(['Enter']);
    const cropped = parseClaudeNativeQuestionScreen(screen.replace('     long\n', ''));
    expect(matchesClaudeNativeQuestionScreen(cropped!, input)).toBe(false);
  });

  it('answers the live Claude 310 narrow form with complete wrapped labels and descriptions', async () => {
    const screen = readFileSync(new URL('./__fixtures__/claude-2.1.310-question-narrow.txt', import.meta.url), 'utf8');
    const question = 'Which approach should this synthetic narrow terminal validation use when the question text and every option label naturally wrap across several display lines?';
    const first = 'Preserve the complete wrapped question and option labels while answering through the existing app controls';
    const second = 'Keep the complete wrapped question and option labels while answering locally in the terminal';
    const input = [{ question, header: 'Approach', options: [first, second], multiSelect: false }];
    const parsed = parseClaudeNativeQuestionScreen(screen);
    expect(parsed).not.toBeNull();
    expect(matchesClaudeNativeQuestionScreen(parsed!, input)).toBe(true);
    const port = createFakeControlPort({ captures: [screen, idle] });
    await expect(answerClaudeNativeQuestion({ ...controls, port, questions: input, answers: { [question]: [first] } })).resolves.toEqual({ status: 'answered' });
    expect(port.sentKeys).toEqual(['Enter']);
  });

  it('recognizes narrow multi-question footers and decorated review rows from real Claude 310 captures', () => {
    const initial = readFileSync(new URL('./__fixtures__/claude-2.1.310-question-multi-narrow.txt', import.meta.url), 'utf8');
    const second = readFileSync(new URL('./__fixtures__/claude-2.1.310-question-second-narrow.txt', import.meta.url), 'utf8');
    const reviewed = readFileSync(new URL('./__fixtures__/claude-2.1.310-question-review-narrow.txt', import.meta.url), 'utf8');
    expect(parseClaudeNativeQuestionScreen(initial)).toMatchObject({ kind: 'question', multiSelect: true });
    expect(parseClaudeNativeQuestionScreen(second)).toMatchObject({ kind: 'question', multiSelect: false });
    expect(parseClaudeNativeQuestionScreen(reviewed)).toMatchObject({ kind: 'review', reviewAnswers: [
      { question: expect.stringContaining('Which synthetic validation ingredients'), answer: expect.stringContaining('Preserve the complete wrapped question') },
      { question: expect.stringContaining('Which synthetic confirmation size'), answer: expect.stringContaining('Use the larger confirmation scope') },
    ] });
    expect(parseClaudeNativeQuestionScreen(`${initial}\nUnexpected active dialog`)).toBeNull();
  });

  it('matches unspaced soft wraps and clips panes by display columns without splitting Unicode graphemes', () => {
    const expected = 'x'.repeat(75);
    const wrapped = single.replaceAll('Which probe color?', `│ ${expected.slice(0, 38)}\n│ ${expected.slice(38)}`);
    const input = [{ ...questions[0]!, question: expected }];
    const parsed = parseClaudeNativeQuestionScreen(wrapped);
    expect(matchesClaudeNativeQuestionScreen(parsed!, input)).toBe(true);
    const combined = 'e\u0301'.repeat(65);
    const withCombiningMarks = single.replaceAll('Which probe color?', combined);
    expect(parseClaudeNativeQuestionScreen(withCombiningMarks)?.question).toBe(combined);
    const width = single.split('\n').find((line) => /^─+$/u.test(line))!.length;
    const text = '雪'.repeat(40);
    const rows = single.replaceAll('Which probe color?', text).split('\n');
    const withWidePane = rows.map((line) => line === text ? `${text}${' '.repeat(width + 4 - 80)}RIGHT_PANEL_CONTENT` : `${line.padEnd(width + 4)}RIGHT_PANEL_CONTENT`).join('\n');
    const wide = parseClaudeNativeQuestionScreen(withWidePane);
    expect(wide?.question).toBe(text);
    expect(matchesClaudeNativeQuestionScreen(wide!, [{ ...questions[0]!, question: text }])).toBe(true);
  });

  it('matches native abbreviated tab captions against full hook-owned questions at phone width', () => {
    const screen = readFileSync(new URL('./__fixtures__/claude-2.1.310-question-four-narrow.txt', import.meta.url), 'utf8');
    const input = ['Containment', 'Secrets', 'Naming', 'Root servers'].map((header) => ({
      header, question: `${header}: Which synthetic choice?`, multiSelect: false, options: ['Alpha', 'Beta'],
    }));
    const parsed = parseClaudeNativeQuestionScreen(screen);
    expect(parsed).not.toBeNull();
    expect(matchesClaudeNativeQuestionScreen(parsed!, input)).toBe(true);
    expect(matchesClaudeNativeQuestionScreen(parsed!, [{ ...input[0]!, question: 'A different current question?' }, ...input.slice(1)])).toBe(false);
  });

  it('preserves literal gutter characters inside a multiline review answer', () => {
    const text = review.replace('→ Apple, Pear', '→ Apple,\n   │ preserve this answer text');
    expect(parseClaudeNativeQuestionScreen(text)?.reviewAnswers[0]?.answer).toBe('Apple,\n│ preserve this answer text');
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
