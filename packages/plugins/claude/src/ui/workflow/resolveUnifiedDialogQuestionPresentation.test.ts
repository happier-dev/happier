import { describe, expect, it } from 'vitest';

import { resolveClaudeUnifiedDialogQuestionPresentation } from './resolveUnifiedDialogQuestionPresentation.js';

describe('resolveClaudeUnifiedDialogQuestionPresentation', () => {
  it('localizes the terminal-only notice without manufacturing an answer option', () => {
    const input = {
      happierDialog: {
        kind: 'unrecognized',
        dialogId: 'unrecognized_confirmation',
        mode: 'notice',
        action: 'open_terminal',
      },
      questions: [{
        header: 'Claude dialog',
        question: 'Open terminal',
        multiSelect: false,
        options: [],
      }],
    };

    expect(resolveClaudeUnifiedDialogQuestionPresentation(input, (key) => `translated:${key}`))
      .toMatchObject({
        questions: [{
          header: 'translated:tools.askUserQuestion.claudeDialogNotice.header',
          options: [],
        }],
      });
  });
});
