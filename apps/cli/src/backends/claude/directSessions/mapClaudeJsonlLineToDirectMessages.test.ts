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

  it('carries canonical role metadata on the schema-mismatch fallback', () => {
    // A known row type whose body cannot be parsed at all still reaches managed storage as an opaque
    // record; without the role it is the one direct-session path that stays unclassified.
    const [item] = mapClaudeJsonlLineToDirectMessages({
      fileRelPath: 'project/session.jsonl',
      lineStartOffsetBytes: 10,
      lineValue: { type: 'assistant', uuid: 42, isApiErrorMessage: true },
    });

    expect((item?.raw as any)?.content?.data?.reason).toBe('schema_mismatch');
    expect(item?.messageRole).toBe('event');
  });
});
