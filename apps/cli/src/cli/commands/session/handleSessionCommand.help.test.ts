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
      expect(output.text()).toContain('happier resume [<session-id-or-prefix>]');
      expect(output.text()).toContain('happier session status <session-id-or-prefix-or-tag> [--live] [--json]');
      expect(output.text()).toContain(SESSION_HELP_LINES.create);
      expect(output.text()).toContain('happier session create [options]\n\nOptions:\n  [--path <path>]');
      expect(output.text()).toContain('happier session send <session-id-or-prefix-or-tag> <message|--message <text>|--prompt <text>> [--permission-mode <mode>] [--model <model-id>] [--wait] [--timeout <seconds>] [--json]');
      expect(output.text()).toContain('happier session wait <session-id-or-prefix-or-tag> [--timeout <seconds>] [--json]');
      expect(output.text()).toContain('happier session stop <session-id-or-prefix-or-tag> [--json]');
      expect(output.text()).toContain('happier session set-title <session-id-or-prefix-or-tag> <title> [--json]');
      expect(output.text()).toContain('happier session set-permission-mode <session-id-or-prefix-or-tag> <mode> [--json]');
      expect(output.text()).toContain('happier session set-model <session-id-or-prefix-or-tag> <model-id> [--json]');
      expect(output.text()).toContain('happier session archive <session-id-or-prefix-or-tag> [--json]');
      expect(output.text()).toContain('happier session unarchive <session-id-or-prefix-or-tag> [--json]');
      expect(output.text()).toContain('happier session history <session-id-or-prefix-or-tag> [--limit N] [--format compact|raw] [--raw] [--include-meta] [--include-structured-payload] [--json]');
      expect(output.text()).toContain('happier session actions list [--json]');
      expect(output.text()).toContain('happier session actions describe <action-id> [--json]');
      expect(output.text()).toContain(SESSION_HELP_LINES.actionsExecute);
      expect(output.text()).toContain('happier session run start <session-id-or-prefix-or-tag> --intent <review|plan|delegate|task|voice_agent|memory_hints|scm_commit_message|scm_diff_summary> --backend <backend-target> [--instructions <text>] [--permission-mode <mode>] [--retention <ephemeral|resumable>] [--run-class <bounded|long_lived>] [--io-mode <request_response|streaming>] [--json]');
      expect(output.text()).toContain('happier session run list <session-id-or-prefix-or-tag> [--backend <backend-target>] [--status <running|succeeded|failed|cancelled|timeout>] [--limit <count>] [--json]');
      expect(output.text()).toContain('happier session run send <session-id-or-prefix-or-tag> <run-id> <message> [--resume] [--json]');
      expect(output.text()).toContain('happier session run stop <session-id-or-prefix-or-tag> <run-id> [--json]');
      expect(output.text()).toContain('happier session run action <session-id-or-prefix-or-tag> <run-id> <action-id> [--input-json <json>] [--json]');
      expect(output.text()).toContain('happier session run wait <session-id-or-prefix-or-tag> <run-id> [--timeout <seconds>] [--json]');
    } finally {
      output.restore();
    }
  });

  it.each([
    ['list', 'happier session list [--active] [--archived] [--limit N] [--cursor C] [--include-system] [--resumable] [--plain] [--json]'],
    ['status', 'happier session status <session-id-or-prefix-or-tag> [--live] [--json]'],
    ['create', SESSION_HELP_LINES.create],
    ['send', 'happier session send <session-id-or-prefix-or-tag> <message|--message <text>|--prompt <text>> [--permission-mode <mode>] [--model <model-id>] [--wait] [--timeout <seconds>] [--json]'],
    ['wait', 'happier session wait <session-id-or-prefix-or-tag> [--timeout <seconds>] [--json]'],
    ['stop', 'happier session stop <session-id-or-prefix-or-tag> [--json]'],
    ['archive', 'happier session archive <session-id-or-prefix-or-tag> [--json]'],
    ['unarchive', 'happier session unarchive <session-id-or-prefix-or-tag> [--json]'],
    ['history', 'happier session history <session-id-or-prefix-or-tag> [--limit N] [--format compact|raw] [--raw] [--include-meta] [--include-structured-payload] [--json]'],
    ['set-title', 'happier session set-title <session-id-or-prefix-or-tag> <title> [--json]'],
    ['set-permission-mode', 'happier session set-permission-mode <session-id-or-prefix-or-tag> <mode> [--json]'],
    ['set-model', 'happier session set-model <session-id-or-prefix-or-tag> <model-id> [--json]'],
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
    [['actions', 'list', '--help'], 'happier session actions list [--json]'],
    [['actions', 'describe', '--help'], 'happier session actions describe <action-id> [--json]'],
    [['actions', 'execute', '--help'], SESSION_HELP_LINES.actionsExecute],
    [['run', '--help'], SESSION_HELP_LINES.runStart],
    [['run', 'start', '--help'], SESSION_HELP_LINES.runStart],
    [['run', 'list', '--help'], SESSION_HELP_LINES.runList],
    [['run', 'get', '--help'], 'happier session run get <session-id-or-prefix-or-tag> <run-id> [--include-structured] [--json]'],
    [['run', 'send', '--help'], 'happier session run send <session-id-or-prefix-or-tag> <run-id> <message> [--resume] [--json]'],
    [['run', 'stop', '--help'], 'happier session run stop <session-id-or-prefix-or-tag> <run-id> [--json]'],
    [['run', 'action', '--help'], 'happier session run action <session-id-or-prefix-or-tag> <run-id> <action-id> [--input-json <json>] [--json]'],
    [['run', 'wait', '--help'], 'happier session run wait <session-id-or-prefix-or-tag> <run-id> [--timeout <seconds>] [--json]'],
    [['run', 'stream-start', '--help'], 'happier session run stream-start <session-id-or-prefix-or-tag> <run-id> <message> [--resume] [--json]'],
    [['run', 'stream-read', '--help'], 'happier session run stream-read <session-id-or-prefix-or-tag> <run-id> <stream-id> --cursor <n> [--max-events <n>] [--json]'],
    [['run', 'stream-cancel', '--help'], 'happier session run stream-cancel <session-id-or-prefix-or-tag> <run-id> <stream-id> [--json]'],
    [['review', '--help'], 'happier session review start <session-id-or-prefix-or-tag> --engines <id1,id2> --instructions <text> [--json]'],
    [['review', 'start', '--help'], 'happier session review start <session-id-or-prefix-or-tag> --engines <id1,id2> --instructions <text> [--json]'],
    [['plan', '--help'], 'happier session plan start <session-id-or-prefix-or-tag> --backends <id1,id2> --instructions <text> [--json]'],
    [['plan', 'start', '--help'], 'happier session plan start <session-id-or-prefix-or-tag> --backends <id1,id2> --instructions <text> [--json]'],
    [['delegate', '--help'], 'happier session delegate start <session-id-or-prefix-or-tag> --backends <id1,id2> --instructions <text> [--json]'],
    [['delegate', 'start', '--help'], 'happier session delegate start <session-id-or-prefix-or-tag> --backends <id1,id2> --instructions <text> [--json]'],
    [['voice-agent', '--help'], 'happier session voice-agent start <session-id-or-prefix-or-tag> --backends <id1,id2> --instructions <text> [--json]'],
    [['voice-agent', 'start', '--help'], 'happier session voice-agent start <session-id-or-prefix-or-tag> --backends <id1,id2> --instructions <text> [--json]'],
    [['voice_agent', 'start', '--help'], 'happier session voice-agent start <session-id-or-prefix-or-tag> --backends <id1,id2> --instructions <text> [--json]'],
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
