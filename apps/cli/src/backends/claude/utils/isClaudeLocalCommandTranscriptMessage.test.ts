import { describe, expect, it } from 'vitest';

import type { RawJSONLines } from '../types';
import { isClaudeLocalCommandTranscriptMessage } from './isClaudeLocalCommandTranscriptMessage';

function userRow(content: string): RawJSONLines {
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid: 'user-row',
    timestamp: '2026-07-02T16:37:57.447Z',
  } as unknown as RawJSONLines;
}

describe('isClaudeLocalCommandTranscriptMessage', () => {
  it('treats Claude local slash-command rows as transcript artifacts', () => {
    expect(isClaudeLocalCommandTranscriptMessage(userRow(
      '<command-name>/model</command-name>\n'
      + '<command-message>model</command-message>\n'
      + '<command-args></command-args>',
    ))).toBe(true);

    expect(isClaudeLocalCommandTranscriptMessage(userRow(
      '<command-name>/effort</command-name>\n'
      + '<command-message>effort</command-message>\n'
      + '<command-args></command-args>',
    ))).toBe(true);
  });

  it('treats Claude local command stdout rows as transcript artifacts', () => {
    expect(isClaudeLocalCommandTranscriptMessage(userRow(
      '<local-command-stdout>Set model to Opus 4.8 and saved as your default for new sessions</local-command-stdout>',
    ))).toBe(true);

    expect(isClaudeLocalCommandTranscriptMessage(userRow(
      '<local-command-stdout>Set effort level to low (saved as your default for new sessions)</local-command-stdout>',
    ))).toBe(true);

    expect(isClaudeLocalCommandTranscriptMessage(userRow([
      '<local-command-stdout>Set model to Opus 4.8 and saved as your default for new sessions',
      'Additional genuine multi-line Claude local-command stdout</local-command-stdout>',
    ].join('\n')))).toBe(true);
  });

  it('does not treat ordinary user text as a local command artifact', () => {
    expect(isClaudeLocalCommandTranscriptMessage(userRow('Please run the model benchmarks.'))).toBe(false);
  });

  it('preserves native shell input and output as visible transcript messages', () => {
    expect(isClaudeLocalCommandTranscriptMessage(userRow('<bash-input> echo hi</bash-input>'))).toBe(false);
    expect(isClaudeLocalCommandTranscriptMessage(userRow('<bash-stdout>hi\n</bash-stdout><bash-stderr></bash-stderr>'))).toBe(false);
  });
});
