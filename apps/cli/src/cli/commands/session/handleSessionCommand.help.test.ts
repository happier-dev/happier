import { describe, expect, it, vi } from 'vitest';

import { captureConsoleText } from '@/testkit/logger/captureOutput';
import { SESSION_CREATE_USAGE } from './create/parseSessionCreateSpawnOptions';

describe('handleSessionCommand help output', () => {
  it('lists the direct session control subcommands and run subcommands', async () => {
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleText();

    try {
      await handleSessionCommand(['--help']);

      expect(output.text()).toContain('happier session list [--active] [--archived] [--limit N] [--cursor C] [--include-system] [--resumable] [--plain] [--json]');
      expect(output.text()).toContain('happier resume [<session-id-or-prefix>]');
      expect(output.text()).toContain('happier session status <session-id-or-prefix-or-tag> [--live] [--json]');
      expect(output.text()).toContain(SESSION_CREATE_USAGE);
      expect(output.text()).toContain('happier session send <session-id-or-prefix-or-tag> <message> [--permission-mode <mode>] [--model <model-id>] [--wait] [--timeout <seconds>] [--json]');
      expect(output.text()).toContain('happier session wait <session-id-or-prefix-or-tag> [--timeout <seconds>] [--json]');
      expect(output.text()).toContain('happier session stop <session-id-or-prefix-or-tag> [--json]');
      expect(output.text()).toContain('happier session set-title <session-id-or-prefix-or-tag> <title> [--json]');
      expect(output.text()).toContain('happier session set-permission-mode <session-id-or-prefix-or-tag> <mode> [--json]');
      expect(output.text()).toContain('happier session set-model <session-id-or-prefix-or-tag> <model-id> [--json]');
      expect(output.text()).toContain('happier session archive <session-id-or-prefix-or-tag> [--json]');
      expect(output.text()).toContain('happier session unarchive <session-id-or-prefix-or-tag> [--json]');
      expect(output.text()).toContain('happier session history <session-id-or-prefix-or-tag> [--limit N] [--format compact|raw] [--include-meta] [--include-structured-payload] [--json]');
      expect(output.text()).toContain('happier session actions list [--json]');
      expect(output.text()).toContain('happier session actions describe <action-id> [--json]');
      expect(output.text()).toContain('happier session actions execute <session-id-or-prefix-or-tag> <action-id> [--input-json <json>] [--action-request-id <id>] [--resume-action-request] [--json]');
      expect(output.text()).toContain('happier session run start <session-id-or-prefix-or-tag> --intent <review|plan|delegate|voice_agent|memory_hints> --backend <backend-target> [--json]');
      expect(output.text()).toContain('happier session run list <session-id-or-prefix-or-tag> [--backend <backend-target>] [--status <status>] [--limit <count>] [--json]');
      expect(output.text()).toContain('happier session run send <session-id-or-prefix-or-tag> <run-id> <message> [--resume] [--json]');
      expect(output.text()).toContain('happier session run stop <session-id-or-prefix-or-tag> <run-id> [--json]');
      expect(output.text()).toContain('happier session run action <session-id-or-prefix-or-tag> <run-id> <action-id> [--input-json <json>] [--json]');
      expect(output.text()).toContain('happier session run wait <session-id-or-prefix-or-tag> <run-id> [--timeout <seconds>] [--json]');
    } finally {
      output.restore();
    }
  });

  it.each([
    [['list', '--help'], 'happier session list [--active]'],
    [['status', '--help'], 'happier session status <session-id-or-prefix-or-tag>'],
    [['create', '--help'], 'happier session create [options]\n\nOptions:\n  [--path <path>]'],
    [['send', '--help'], 'happier session send <session-id-or-prefix-or-tag> <message>'],
    [['wait', '--help'], 'happier session wait <session-id-or-prefix-or-tag>'],
    [['stop', '--help'], 'happier session stop <session-id-or-prefix-or-tag>'],
    [['history', '--help'], 'happier session history <session-id-or-prefix-or-tag>'],
    [['set-title', '--help'], 'happier session set-title <session-id-or-prefix-or-tag> <title>'],
    [['set-permission-mode', '--help'], 'happier session set-permission-mode <session-id-or-prefix-or-tag> <mode>'],
    [['set-model', '--help'], 'happier session set-model <session-id-or-prefix-or-tag> <model-id>'],
    [['archive', '--help'], 'happier session archive <session-id-or-prefix-or-tag>'],
    [['unarchive', '--help'], 'happier session unarchive <session-id-or-prefix-or-tag>'],
    [['review', '--help'], 'happier session review start <session-id-or-prefix-or-tag>'],
    [['review', 'start', '--help'], 'happier session review start <session-id-or-prefix-or-tag>'],
    [['plan', '--help'], 'happier session plan start <session-id-or-prefix-or-tag>'],
    [['plan', 'start', '--help'], 'happier session plan start <session-id-or-prefix-or-tag>'],
    [['delegate', '--help'], 'happier session delegate start <session-id-or-prefix-or-tag>'],
    [['delegate', 'start', '--help'], 'happier session delegate start <session-id-or-prefix-or-tag>'],
    [['voice-agent', '--help'], 'happier session voice-agent start <session-id-or-prefix-or-tag>'],
    [['voice-agent', 'start', '--help'], 'happier session voice-agent start <session-id-or-prefix-or-tag>'],
    [['actions', '--help'], 'happier session actions list [--json]'],
    [['actions', 'list', '--help'], 'happier session actions list [--json]'],
    [['actions', 'describe', '--help'], 'happier session actions describe <action-id>'],
    [['actions', 'execute', '--help'], 'happier session actions execute <session-id-or-prefix-or-tag> <action-id>'],
    [['run', '--help'], 'happier session run start <session-id-or-prefix-or-tag> --intent <review|plan|delegate|voice_agent|memory_hints>'],
    [['run', 'start', '--help'], 'happier session run start <session-id-or-prefix-or-tag> --intent <review|plan|delegate|voice_agent|memory_hints>'],
    [['run', 'list', '--help'], 'happier session run list <session-id-or-prefix-or-tag>'],
    [['run', 'get', '--help'], 'happier session run get <session-id-or-prefix-or-tag> <run-id>'],
    [['run', 'send', '--help'], 'happier session run send <session-id-or-prefix-or-tag> <run-id> <message>'],
    [['run', 'stop', '--help'], 'happier session run stop <session-id-or-prefix-or-tag> <run-id>'],
    [['run', 'action', '--help'], 'happier session run action <session-id-or-prefix-or-tag> <run-id> <action-id>'],
    [['run', 'wait', '--help'], 'happier session run wait <session-id-or-prefix-or-tag> <run-id>'],
    [['run', 'stream-start', '--help'], 'happier session run stream-start <session-id-or-prefix-or-tag> <run-id> <message>'],
    [['run', 'stream-read', '--help'], 'happier session run stream-read <session-id-or-prefix-or-tag> <run-id> <stream-id>'],
    [['run', 'stream-cancel', '--help'], 'happier session run stream-cancel <session-id-or-prefix-or-tag> <run-id> <stream-id>'],
  ] as const)('prints usage for `%s` without prompting for credentials', async (argv, expectedUsage) => {
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleText();
    const readCredentialsFn = vi.fn(async () => {
      throw new Error('credentials must not be read for session help');
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
