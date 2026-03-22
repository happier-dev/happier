import { describe, expect, it } from 'vitest';

import { buildHappierReplayPromptFromDialog } from './happierReplayPrompt.js';

describe('buildHappierReplayPromptFromDialog', () => {
  it('renders a stable replay header plus recent dialog items', () => {
    const prompt = buildHappierReplayPromptFromDialog({
      previousSessionId: 'sess_prev',
      strategy: 'recent_messages',
      recentMessagesCount: 3,
      dialog: [
        { role: 'User', createdAt: 1, text: 'hi' },
        { role: 'Assistant', createdAt: 2, text: 'hello' },
        { role: 'User', createdAt: 3, text: 'context 1' },
        { role: 'Assistant', createdAt: 4, text: 'context 2' },
      ],
    });

    expect(prompt).toContain('Previous session id: sess_prev');
    expect(prompt).toContain('Recent transcript:');
    expect(prompt).toContain('Assistant: hello');
    expect(prompt).toContain('User: context 1');
    expect(prompt).toContain('Assistant: context 2');
    expect(prompt).not.toContain('User: hi');
  });

  it('drops empty/whitespace-only dialog text', () => {
    const prompt = buildHappierReplayPromptFromDialog({
      previousSessionId: 'sess_prev',
      strategy: 'recent_messages',
      recentMessagesCount: 10,
      dialog: [
        { role: 'User', createdAt: 1, text: '   ' },
        { role: 'Assistant', createdAt: 2, text: '' },
        { role: 'User', createdAt: 3, text: 'ok' },
      ],
    });

    expect(prompt).toContain('User: ok');
    expect(prompt).not.toContain('Assistant:');
    expect(prompt.split('User:').length - 1).toBe(1);
  });

  it('allows including more than 100 messages when recentMessagesCount exceeds 100', () => {
    const dialog = Array.from({ length: 120 }, (_, idx) => {
      const i = idx + 1;
      return {
        role: i % 2 === 0 ? ('Assistant' as const) : ('User' as const),
        createdAt: i,
        text: i === 1 ? 'first-unique' : `m-${i}`,
      };
    });

    const prompt = buildHappierReplayPromptFromDialog({
      previousSessionId: 'sess_prev',
      strategy: 'recent_messages',
      recentMessagesCount: 150,
      dialog,
    });

    expect(prompt).toContain('User: first-unique');
  });

  it('allows requesting more than 200 messages when recentMessagesCount exceeds 200', () => {
    const dialog = Array.from({ length: 300 }, (_, idx) => {
      const i = idx + 1;
      return {
        role: i % 2 === 0 ? ('Assistant' as const) : ('User' as const),
        createdAt: i,
        text: i === 1 ? 'first-unique-over-200' : `m-${i}`,
      };
    });

    const prompt = buildHappierReplayPromptFromDialog({
      previousSessionId: 'sess_prev',
      strategy: 'recent_messages',
      recentMessagesCount: 500,
      dialog,
    });

    expect(prompt).toContain('User: first-unique-over-200');
  });

  it('includes summary text when strategy is summary_plus_recent', () => {
    const prompt = buildHappierReplayPromptFromDialog({
      previousSessionId: 'sess_prev',
      strategy: 'summary_plus_recent',
      recentMessagesCount: 2,
      summaryText: 'SUMMARY_OK',
      dialog: [
        { role: 'User', createdAt: 1, text: 'hi' },
        { role: 'Assistant', createdAt: 2, text: 'hello' },
        { role: 'User', createdAt: 3, text: 'context 1' },
      ],
    });

    expect(prompt).toContain('Summary:');
    expect(prompt).toContain('SUMMARY_OK');
    expect(prompt).toContain('The summary below is the authoritative condensed context from earlier transcript history.');
    expect(prompt).toContain('The recent transcript is only the tail and may omit older important details.');
    expect(prompt).toContain('Recent transcript:');
    expect(prompt).toContain('Assistant: hello');
    expect(prompt).toContain('User: context 1');
    expect(prompt).not.toContain('User: hi');
  });

  it('shrinks the recent transcript tail to fit maxPromptChars', () => {
    const prompt = buildHappierReplayPromptFromDialog({
      previousSessionId: 'sess_prev',
      strategy: 'recent_messages',
      recentMessagesCount: 10,
      maxPromptChars: 440,
      dialog: [
        { role: 'User', createdAt: 1, text: 'old-1' },
        { role: 'Assistant', createdAt: 2, text: 'old-2' },
        { role: 'User', createdAt: 3, text: 'old-3' },
        { role: 'Assistant', createdAt: 4, text: 'new-4' },
        { role: 'User', createdAt: 5, text: 'new-5' },
      ],
    });

    expect(prompt).toContain('Recent transcript:');
    expect(prompt).toContain('User: new-5');
    expect(prompt).toContain('Assistant: new-4');
    expect(prompt).not.toContain('User: old-1');
  });
});
