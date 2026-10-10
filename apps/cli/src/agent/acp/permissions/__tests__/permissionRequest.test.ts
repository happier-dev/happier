import { describe, expect, it } from 'vitest';

import {
  extractPermissionInputWithFallback,
  extractPermissionToolNameHint,
  refinePermissionToolNameWithInput,
  resolvePermissionToolName,
  shouldReplaceCachedPermissionToolName,
} from '../permissionRequest';

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

  it('keeps write inputs whose content field is the file text', () => {
    const rawInput = { file_path: '/tmp/outside/a.txt', content: 'OUTSIDE_DEFAULT_E2E' };
    expect(
      extractPermissionInputWithFallback(
        { toolCall: { kind: 'edit', rawInput } },
        'call_write',
        new Map(),
      ),
    ).toEqual(rawInput);
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

  it('uses execute tool titles as command input before generic permission option labels', () => {
    const titleCommand = "node apps/cli/src/index.ts tools call --source happier --tool change_title --args-json '{\"title\":\"Project Deep Analysis and Audit\"}' --json";

    expect(
      extractPermissionInputWithFallback(
        {
          toolCall: {
            kind: 'execute',
            title: titleCommand,
          },
          options: [
            { optionId: 'proceed_session', kind: 'allow_session', name: 'Allow for this session' },
            { optionId: 'cancel', kind: 'reject_once', name: 'Reject' },
          ],
        },
        'call_4',
        new Map(),
      ),
    ).toEqual({ command: titleCommand });
  });

  it('normalizes shell-prefixed execute titles to the raw command', () => {
    expect(
      extractPermissionInputWithFallback(
        {
          toolCall: {
            kind: 'execute',
            title: 'Shell: sleep 999',
          },
        },
        'call_shell_title',
        new Map(),
      ),
    ).toEqual({ command: 'sleep 999' });
  });

  it('preserves execute tool title commands without stripping command-like prefixes', () => {
    const titleCommand = "run node apps/cli/src/index.ts tools call --source happier --tool change_title --args-json '{\"title\":\"Project Deep Analysis and Audit\"}' --json";

    expect(
      extractPermissionInputWithFallback(
        {
          toolCall: {
            kind: 'execute',
            title: titleCommand,
          },
        },
        'call_execute_title_with_run_prefix',
        new Map(),
      ),
    ).toEqual({ command: titleCommand });
  });

  it('uses the cached input fallback instead of deriving commands from option labels', () => {
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
        },
        'call_5',
        new Map([['call_5', { command: 'bash -lc "echo cached"' }]]),
      ),
    ).toEqual({ command: 'bash -lc "echo cached"' });
  });

  it('derives a shell command from explicit option-label code blocks when no cached input exists yet', () => {
    expect(
      extractPermissionInputWithFallback(
        {
          toolCall: {
            kind: 'execute',
            title: 'Run shell command',
            input: {},
          },
          options: [
            { optionId: 'proceed_once', kind: 'allow_once', name: 'Allow `bash -lc \"echo hi\"`' },
            { optionId: 'cancel', kind: 'reject_once', name: 'Reject' },
          ],
        },
        'call_option_codeblock',
        new Map(),
      ),
    ).toEqual({ command: 'bash -lc "echo hi"' });
  });

  it('does not derive command input from option labels when provider sends an empty input string', () => {
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
        },
        'call_6',
        new Map(),
      ),
    ).toEqual({});
  });

  it('does not derive command input from option labels when provider sends an empty argv array', () => {
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
        },
        'call_7',
        new Map(),
      ),
    ).toEqual({});
  });

  it('does not treat non-execute tool titles as command input', () => {
    expect(
      extractPermissionInputWithFallback(
        {
          toolCall: {
            kind: 'read',
            title: "node apps/cli/src/index.ts tools call --source happier --tool change_title --args-json '{}'",
          },
          options: [
            { optionId: 'proceed_session', kind: 'allow_session', name: 'Allow for this session' },
            { optionId: 'cancel', kind: 'reject_once', name: 'Reject' },
          ],
        },
        'call_non_execute_title',
        new Map(),
      ),
    ).toEqual({});
  });

  it('uses cached command input instead of generic execute titles', () => {
    expect(
      extractPermissionInputWithFallback(
        {
          toolCall: {
            kind: 'execute',
            title: 'Run shell command',
            input: {},
          },
          options: [
            { optionId: 'proceed_session', kind: 'allow_session', name: 'Allow for this session' },
            { optionId: 'cancel', kind: 'reject_once', name: 'Reject' },
          ],
        },
        'call_generic_execute_title',
        new Map([['call_generic_execute_title', { command: 'bash -lc "echo cached"' }]]),
      ),
    ).toEqual({ command: 'bash -lc "echo cached"' });
  });

  it('uses execute titles when the resolved tool name is shell-like', () => {
    const titleCommand = "node apps/cli/src/index.ts tools call --source happier --tool change_title --args-json '{\"title\":\"Resolved Shell\"}' --json";

    expect(
      extractPermissionInputWithFallback(
        {
          toolCall: {
            kind: 'other',
            toolName: 'unknown',
            title: titleCommand,
          },
        },
        'call_resolved_shell_title',
        new Map(),
        { toolNameHint: 'Bash' },
      ),
    ).toEqual({ command: titleCommand });
  });

  it('prefers rich toolCall content when rawInput only contains shell metadata', () => {
    expect(
      extractPermissionInputWithFallback(
        {
          toolCall: {
            kind: 'execute',
            rawInput: {
              title: 'Shell',
              description: 'Shell',
              _acp: { title: 'Shell' },
            },
            content: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text:
                    "Requesting approval to perform: Run command `node apps/cli/src/index.ts tools call --source happier --tool change_title --args-json '{\"title\":\"Get QA Marker\"}' --json`",
                },
              },
            ],
          },
        } as any,
        'call_8',
        new Map(),
      ),
    ).toEqual({
      command:
        "node apps/cli/src/index.ts tools call --source happier --tool change_title --args-json '{\"title\":\"Get QA Marker\"}' --json",
    });
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

  it('infers ACP web wrapper tool names from rawInput metadata when kind is a generic file/web family', () => {
    expect(
      extractPermissionToolNameHint({
        toolCall: {
          kind: 'read',
          toolName: 'Read',
          rawInput: {
            title: 'web_fetch',
            description: 'web_fetch',
            _acp: { title: 'web_fetch' },
            url: 'https://example.com',
          },
        },
      } as any),
    ).toBe('web_fetch');
  });

  it('infers change_title from ACP metadata when the provider reports a generic tool kind', () => {
    expect(
      extractPermissionToolNameHint({
        toolCall: {
          kind: 'other',
          toolName: 'unknown',
          rawInput: {
            title: 'change_title',
            description: 'change_title',
            _acp: { title: 'change_title' },
          },
        },
      } as any),
    ).toBe('change_title');
  });
});

describe('resolvePermissionToolName', () => {
  it('upgrades a cached generic tool name when permission metadata is more specific', () => {
    expect(
      resolvePermissionToolName({
        toolNameHint: 'web_fetch',
        toolCallId: 'call_fetch_1',
        toolCallIdToNameMap: new Map([['call_fetch_1', 'read']]),
      }),
    ).toBe('web_fetch');
  });

  it('does not downgrade a cached specific tool name to a generic hint', () => {
    expect(
      resolvePermissionToolName({
        toolNameHint: 'read',
        toolCallId: 'call_fetch_2',
        toolCallIdToNameMap: new Map([['call_fetch_2', 'web_fetch']]),
      }),
    ).toBe('web_fetch');
  });

  it('upgrades cached tool names when the new hint is higher risk (even if not more specific)', () => {
    expect(shouldReplaceCachedPermissionToolName('read', 'bash')).toBe(true);
    expect(
      resolvePermissionToolName({
        toolNameHint: 'bash',
        toolCallId: 'call_bash_1',
        toolCallIdToNameMap: new Map([['call_bash_1', 'read']]),
      }),
    ).toBe('bash');
  });
});

describe('refinePermissionToolNameWithInput', () => {
  it('upgrades a generic read hint when fallback input carries ACP web_fetch metadata', () => {
    expect(
      refinePermissionToolNameWithInput('read', {
        title: 'web_fetch',
        description: 'web_fetch',
        _acp: { title: 'web_fetch' },
      }),
    ).toBe('web_fetch');
  });

  it('does not downgrade a specific tool name when fallback input is generic', () => {
    expect(
      refinePermissionToolNameWithInput('web_fetch', {
        title: 'read',
        description: 'read',
        _acp: { title: 'read' },
      }),
    ).toBe('web_fetch');
  });
});
