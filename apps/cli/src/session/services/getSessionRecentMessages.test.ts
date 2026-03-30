import { describe, expect, it } from 'vitest';

import { extractRecentMessagesFromTranscriptRows } from './getSessionRecentMessages';

describe('extractRecentMessagesFromTranscriptRows', () => {
  it('filters roles, skips memory artifacts, and truncates message text', () => {
    const rows = [
      {
        seq: 3,
        createdAt: 30,
        content: {
          t: 'plain',
          v: {
            role: 'user',
            content: { type: 'text', text: 'hello world' },
            meta: {},
          },
        },
      },
      {
        seq: 2,
        createdAt: 20,
        content: {
          t: 'plain',
          v: {
            role: 'assistant',
            content: { type: 'text', text: 'skip me' },
            meta: { happier: { kind: 'session_synopsis.v1', payload: {} } },
          },
        },
      },
      {
        seq: 1,
        createdAt: 10,
        content: {
          t: 'plain',
          v: {
            role: 'assistant',
            content: { type: 'text', text: 'assistant text' },
            meta: {},
          },
        },
      },
    ] as const;

    const result = extractRecentMessagesFromTranscriptRows({
      rows,
      ctx: { encryptionKey: new Uint8Array([1]), encryptionVariant: 'legacy' },
      includeUser: true,
      includeAssistant: true,
      maxCharsPerMessage: 5,
    });

    expect(result).toEqual([
      { id: '3', createdAt: 30, role: 'user', text: 'hello' },
      { id: '1', createdAt: 10, role: 'assistant', text: 'assis' },
    ]);
  });

  it('excludes assistant messages when includeAssistant is false', () => {
    const rows = [
      {
        seq: 1,
        createdAt: 10,
        content: {
          t: 'plain',
          v: {
            role: 'assistant',
            content: { type: 'text', text: 'assistant text' },
            meta: {},
          },
        },
      },
    ] as const;

    const result = extractRecentMessagesFromTranscriptRows({
      rows,
      ctx: { encryptionKey: new Uint8Array([1]), encryptionVariant: 'legacy' },
      includeUser: true,
      includeAssistant: false,
      maxCharsPerMessage: null,
    });

    expect(result).toEqual([]);
  });
});
