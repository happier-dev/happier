import { describe, expect, it } from 'vitest';

import { extractPermissionInputWithFallback, extractPermissionToolNameHint } from './permissionRequest';

describe('extractPermissionInputWithFallback', () => {
  it('uses params input when present', () => {
    expect(
      extractPermissionInputWithFallback(
        { toolCall: { rawInput: { filePath: '/tmp/a' } } },
        'call_1',
        new Map([['call_1', { filePath: '/tmp/fallback' }]])
      )
    ).toEqual({ filePath: '/tmp/a' });
  });

  it('uses toolCallId fallback when params input is empty', () => {
    expect(
      extractPermissionInputWithFallback(
        { toolCall: { kind: 'other' } },
        'call_2',
        new Map([['call_2', { filePath: '/tmp/fallback' }]])
      )
    ).toEqual({ filePath: '/tmp/fallback' });
  });

  it('returns empty object when nothing is available', () => {
    expect(extractPermissionInputWithFallback({}, 'call_3', new Map())).toEqual({});
  });
});

describe('extractPermissionToolNameHint', () => {
  it('prefers title-derived tool name when kind is generic and title is more specific', () => {
    expect(
      extractPermissionToolNameHint({
        toolCall: {
          kind: 'other',
          toolName: 'Read',
          title: 'Edit file outside working directory: /tmp/outside.txt',
        },
      })
    ).toBe('Edit');
  });

  it('does not downgrade a dangerous toolName based on a safer-looking title', () => {
    expect(
      extractPermissionToolNameHint({
        toolCall: {
          kind: 'other',
          toolName: 'Bash',
          title: 'Read file outside working directory: /tmp/outside.txt',
        },
      })
    ).toBe('Bash');
  });

  it('does not override toolName with non-tool title prefixes', () => {
    expect(
      extractPermissionToolNameHint({
        toolCall: {
          kind: 'other',
          toolName: 'Read',
          title: 'Access to file outside working directory: /tmp/outside.txt',
        },
      })
    ).toBe('Read');
  });
});
