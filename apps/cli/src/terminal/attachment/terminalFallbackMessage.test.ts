import { describe, expect, it } from 'vitest';

import type { Metadata } from '@/api/types';

import { buildTerminalFallbackMessage } from './terminalFallbackMessage';

describe('buildTerminalFallbackMessage', () => {
  it('returns null when tmux was not requested', () => {
    const terminal: NonNullable<Metadata['terminal']> = { mode: 'plain' };
    expect(buildTerminalFallbackMessage(terminal)).toBeNull();
  });

  it('returns a user-facing message when tmux was requested but we fell back to plain', () => {
    const terminal: NonNullable<Metadata['terminal']> = {
      mode: 'plain',
      requested: 'tmux',
      fallbackReason: 'tmux is not available on this machine',
    };

    expect(buildTerminalFallbackMessage(terminal)).toMatch('tmux');
    expect(buildTerminalFallbackMessage(terminal)).toMatch('tmux is not available on this machine');
  });

  it('returns message without reason when fallback reason is missing or blank', () => {
    const noReason: NonNullable<Metadata['terminal']> = {
      mode: 'plain',
      requested: 'tmux',
    };
    const blankReason: NonNullable<Metadata['terminal']> = {
      mode: 'plain',
      requested: 'tmux',
      fallbackReason: '   ',
    };

    const noReasonMessage = buildTerminalFallbackMessage(noReason);
    const blankReasonMessage = buildTerminalFallbackMessage(blankReason);
    expect(noReasonMessage).toMatch(`couldn't be started in tmux`);
    expect(blankReasonMessage).toMatch(`couldn't be started in tmux`);
    expect(noReasonMessage).not.toMatch('Reason:');
    expect(blankReasonMessage).not.toMatch('Reason:');
  });

  it('returns null when plain mode was requested explicitly', () => {
    const terminal: NonNullable<Metadata['terminal']> = {
      mode: 'plain',
      requested: 'plain',
      fallbackReason: 'irrelevant',
    };

    expect(buildTerminalFallbackMessage(terminal)).toBeNull();
  });
});
