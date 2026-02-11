import { describe, expect, it } from 'vitest';

import { extractPermissionInputWithFallback, extractPermissionToolNameHint } from '../permissionRequest';

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

  it('wraps raw argv arrays as a command record', () => {
    expect(
      extractPermissionInputWithFallback(
        { toolCall: { rawInput: ['bash', '-lc', 'echo hi'] } },
        'call_argv',
        new Map(),
      ),
    ).toEqual({ command: ['bash', '-lc', 'echo hi'] });
  });

  it('wraps raw string inputs as a command record', () => {
    expect(
      extractPermissionInputWithFallback(
        { toolCall: { rawInput: "bash -lc 'echo hi'" } },
        'call_str',
        new Map(),
      ),
    ).toEqual({ command: "bash -lc 'echo hi'" });
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

  it('extracts command hints from permission option labels when input payload is empty', () => {
    expect(
      extractPermissionInputWithFallback(
        {
          toolCall: { kind: 'execute' },
          options: [
            { optionId: 'proceed_always', kind: 'allow_always', name: 'Always Allow bash, redirection (>)' },
            { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
            { optionId: 'cancel', kind: 'reject_once', name: 'Reject' },
          ],
        } as any,
        'call_4',
        new Map(),
      ),
    ).toEqual({ command: 'bash, redirection (>)' });
  });

  it('falls back to option label command hints when provider sends an empty input object', () => {
    expect(
      extractPermissionInputWithFallback(
        {
          toolCall: {
            kind: 'execute',
            input: {},
          },
          options: [
            { optionId: 'proceed_always', kind: 'allow_always', name: 'Always Allow bash' },
            { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
            { optionId: 'cancel', kind: 'reject_once', name: 'Reject' },
          ],
        } as any,
        'call_5',
        new Map(),
      ),
    ).toEqual({ command: 'bash' });
  });

  it('falls back to option label command hints when provider sends an empty input string', () => {
    expect(
      extractPermissionInputWithFallback(
        {
          toolCall: {
            kind: 'execute',
            rawInput: '',
          },
          options: [
            { optionId: 'proceed_always', kind: 'allow_always', name: 'Always Allow bash' },
            { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
            { optionId: 'cancel', kind: 'reject_once', name: 'Reject' },
          ],
        } as any,
        'call_6',
        new Map(),
      ),
    ).toEqual({ command: 'bash' });
  });

  it('falls back to option label command hints when provider sends an empty argv array', () => {
    expect(
      extractPermissionInputWithFallback(
        {
          toolCall: {
            kind: 'execute',
            rawInput: [],
          },
          options: [
            { optionId: 'proceed_always', kind: 'allow_always', name: 'Always Allow bash' },
            { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow' },
            { optionId: 'cancel', kind: 'reject_once', name: 'Reject' },
          ],
        } as any,
        'call_7',
        new Map(),
      ),
    ).toEqual({ command: 'bash' });
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
