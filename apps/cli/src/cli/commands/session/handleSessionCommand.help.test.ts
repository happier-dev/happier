import { describe, expect, it, vi } from 'vitest';

import { captureConsoleText } from '@/testkit/logger/captureOutput';
import { handleSessionCommand } from './handleSessionCommand';
import { SESSION_HELP_LINES } from './shared/sessionCommandUsage';

describe('handleSessionCommand help output', () => {
  it('lists the direct session control subcommands and run subcommands', async () => {
    const output = captureConsoleText();

    try {
      await handleSessionCommand(['--help']);

      expect(output.text()).toContain('happier session list [--active] [--archived] [--limit N] [--cursor C] [--include-system] [--resumable] [--plain] [--json]');
      expect(output.text()).toContain('happier session status <session-id-or-prefix> [--live] [--json]');
      expect(output.text()).toContain(SESSION_HELP_LINES.create);
      expect(output.text()).toContain('happier session send <session-id-or-prefix> <message|--message <text>|--prompt <text>> [--permission-mode <mode>] [--model <model-id>] [--wait] [--timeout <seconds>] [--json]');
      expect(output.text()).toContain('happier session wait <session-id-or-prefix> [--timeout <seconds>] [--json]');
      expect(output.text()).toContain('happier session stop <session-id-or-prefix> [--json]');
      expect(output.text()).toContain('happier session set-title <session-id-or-prefix> <title> [--json]');
      expect(output.text()).toContain('happier session set-permission-mode <session-id-or-prefix> <mode> [--json]');
      expect(output.text()).toContain('happier session set-model <session-id-or-prefix> <model-id> [--json]');
      expect(output.text()).toContain('happier session archive <session-id-or-prefix> [--json]');
      expect(output.text()).toContain('happier session unarchive <session-id-or-prefix> [--json]');
      expect(output.text()).toContain('happier session history <session-id-or-prefix> [--limit N] [--format compact|raw] [--raw] [--include-meta] [--include-structured-payload] [--json]');
      expect(output.text()).toContain('happier session actions list [--json]');
      expect(output.text()).toContain('happier session actions describe <action-id> [--json]');
      expect(output.text()).toContain('happier session actions execute <session-id-or-prefix> <action-id> [--input-json <json>] [--json]');
      expect(output.text()).toContain('happier session run start <session-id-or-prefix> --intent <intent> --backend <backend-target> [--instructions <text>] [--permission-mode <mode>] [--retention <policy>] [--run-class <class>] [--io-mode <mode>] [--json]');
      expect(output.text()).toContain('happier session run list <session-id-or-prefix> [--backend <backend-target>] [--status <status>] [--limit <count>] [--json]');
      expect(output.text()).toContain('happier session run send <session-id-or-prefix> <run-id> <message> [--resume] [--json]');
      expect(output.text()).toContain('happier session run stop <session-id-or-prefix> <run-id> [--json]');
      expect(output.text()).toContain('happier session run action <session-id-or-prefix> <run-id> <action-id> [--input-json <json>] [--json]');
      expect(output.text()).toContain('happier session run wait <session-id-or-prefix> <run-id> [--timeout <seconds>] [--json]');
    } finally {
      output.restore();
    }
  });

  it.each([
    ['list', 'happier session list [--active] [--archived] [--limit N] [--cursor C] [--include-system] [--resumable] [--plain] [--json]'],
    ['status', 'happier session status <session-id-or-prefix> [--live] [--json]'],
    ['create', SESSION_HELP_LINES.create],
    ['send', 'happier session send <session-id-or-prefix> <message|--message <text>|--prompt <text>> [--permission-mode <mode>] [--model <model-id>] [--wait] [--timeout <seconds>] [--json]'],
    ['wait', 'happier session wait <session-id-or-prefix> [--timeout <seconds>] [--json]'],
    ['stop', 'happier session stop <session-id-or-prefix> [--json]'],
    ['archive', 'happier session archive <session-id-or-prefix> [--json]'],
    ['unarchive', 'happier session unarchive <session-id-or-prefix> [--json]'],
    ['history', 'happier session history <session-id-or-prefix> [--limit N] [--format compact|raw] [--raw] [--include-meta] [--include-structured-payload] [--json]'],
    ['set-title', 'happier session set-title <session-id-or-prefix> <title> [--json]'],
    ['set-permission-mode', 'happier session set-permission-mode <session-id-or-prefix> <mode> [--json]'],
    ['set-model', 'happier session set-model <session-id-or-prefix> <model-id> [--json]'],
  ] as const)('prints usage for `%s --help` without prompting for credentials', async (subcommand, expectedUsage) => {
    const output = captureConsoleText();
    const readCredentialsFn = vi.fn(async () => {
      throw new Error('readCredentialsFn should not be called for session help');
    });

    try {
      await handleSessionCommand([subcommand, '--help'], { readCredentialsFn });

      expect(output.text()).toContain(expectedUsage);
      expect(output.text()).not.toContain('Not authenticated');
      expect(readCredentialsFn).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });

  it.each([
    [['actions', '--help'], 'happier session actions list [--json]'],
    [['actions', 'describe', '--help'], 'happier session actions describe <action-id> [--json]'],
    [['actions', 'execute', '--help'], 'happier session actions execute <session-id-or-prefix> <action-id> [--input-json <json>] [--json]'],
    [['run', '--help'], 'happier session run start <session-id-or-prefix> --intent <intent> --backend <backend-target> [--instructions <text>] [--permission-mode <mode>] [--retention <policy>] [--run-class <class>] [--io-mode <mode>] [--json]'],
    [['run', 'start', '--help'], 'happier session run start <session-id-or-prefix> --intent <intent> --backend <backend-target> [--instructions <text>] [--permission-mode <mode>] [--retention <policy>] [--run-class <class>] [--io-mode <mode>] [--json]'],
    [['run', 'list', '--help'], 'happier session run list <session-id-or-prefix> [--backend <backend-target>] [--status <status>] [--limit <count>] [--json]'],
    [['run', 'get', '--help'], 'happier session run get <session-id-or-prefix> <run-id> [--include-structured] [--json]'],
    [['run', 'send', '--help'], 'happier session run send <session-id-or-prefix> <run-id> <message> [--resume] [--json]'],
    [['run', 'stop', '--help'], 'happier session run stop <session-id-or-prefix> <run-id> [--json]'],
    [['run', 'action', '--help'], 'happier session run action <session-id-or-prefix> <run-id> <action-id> [--input-json <json>] [--json]'],
    [['run', 'wait', '--help'], 'happier session run wait <session-id-or-prefix> <run-id> [--timeout <seconds>] [--json]'],
    [['run', 'stream-start', '--help'], 'happier session run stream-start <session-id-or-prefix> <run-id> <message> [--resume] [--json]'],
    [['run', 'stream-read', '--help'], 'happier session run stream-read <session-id-or-prefix> <run-id> <stream-id> --cursor <n> [--max-events <n>] [--json]'],
    [['run', 'stream-cancel', '--help'], 'happier session run stream-cancel <session-id-or-prefix> <run-id> <stream-id> [--json]'],
    [['review', '--help'], 'happier session review start <session-id-or-prefix> --engines <id1,id2> --instructions <text> [--json]'],
    [['plan', '--help'], 'happier session plan start <session-id-or-prefix> --backends <id1,id2> --instructions <text> [--json]'],
    [['delegate', '--help'], 'happier session delegate start <session-id-or-prefix> --backends <id1,id2> --instructions <text> [--json]'],
    [['voice-agent', '--help'], 'happier session voice-agent start <session-id-or-prefix> --backends <id1,id2> --instructions <text> [--json]'],
  ] as const)('prints usage for nested `%s` without prompting for credentials', async (argv, expectedUsage) => {
    const output = captureConsoleText();
    const readCredentialsFn = vi.fn(async () => {
      throw new Error('readCredentialsFn should not be called for session help');
    });

    try {
      await handleSessionCommand([...argv], { readCredentialsFn });

      expect(output.text()).toContain(expectedUsage);
      expect(output.text()).not.toContain('Not authenticated');
      expect(readCredentialsFn).not.toHaveBeenCalled();
    } finally {
      output.restore();
    }
  });
});
