import { describe, expect, it } from 'vitest';

import { mapClaudeJsonlLineToDirectMessages } from './mapClaudeJsonlLineToDirectMessages';

describe('mapClaudeJsonlLineToDirectMessages', () => {
  it.each([
    ['message-less assistant', { type: 'assistant', uuid: 'assistant-api-error', isApiErrorMessage: true }, 'event'],
    [
      'assistant text with missing nested role',
      { type: 'assistant', uuid: 'assistant-missing-role', message: { content: [{ type: 'text', text: 'hello' }] } },
      'agent',
    ],
  ] as const)('carries canonical role metadata for %s', (_name, lineValue, expectedRole) => {
    const [item] = mapClaudeJsonlLineToDirectMessages({
      fileRelPath: 'project/session.jsonl',
      lineStartOffsetBytes: 10,
      lineValue,
    });

    expect(item?.messageRole).toBe(expectedRole);
  });
});
