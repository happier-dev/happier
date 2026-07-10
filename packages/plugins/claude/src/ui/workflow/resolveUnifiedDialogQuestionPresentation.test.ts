import { describe, expect, it } from 'vitest';

import { resolveClaudeUnifiedDialogQuestionPresentation } from './resolveUnifiedDialogQuestionPresentation.js';

describe('resolveClaudeUnifiedDialogQuestionPresentation', () => {
  it('localizes the plugin-owned unrecognized-dialog notice without changing its stable answer value', () => {
    const input = {
      happierDialog: {
        kind: 'unrecognized',
        dialogId: 'unrecognized_confirmation',
        notice: 'open_terminal',
      },
      questions: [{
        header: 'Claude dialog',
        question: 'Open terminal',
        multiSelect: false,
        options: [{ choice: 'open_terminal', label: 'Open terminal', description: 'Continue' }],
      }],
    };

    expect(resolveClaudeUnifiedDialogQuestionPresentation(input, (key) => `translated:${key}`))
      .toMatchObject({
        questions: [{
          header: 'translated:tools.askUserQuestion.claudeDialogNotice.header',
          options: [{
            choice: 'open_terminal',
            label: 'translated:tools.askUserQuestion.claudeDialogNotice.openTerminal',
          }],
        }],
      });
  });
});
