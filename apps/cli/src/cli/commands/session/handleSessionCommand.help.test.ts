import { describe, expect, it } from 'vitest';

import { captureConsoleText } from '@/testkit/logger/captureOutput';

describe('handleSessionCommand help output', () => {
  it('lists the direct session control subcommands and run subcommands', async () => {
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleText();

    try {
      await handleSessionCommand(['--help']);

      expect(output.text()).toContain('happier session list [--active] [--archived] [--limit N] [--cursor C] [--include-system] [--resumable] [--plain] [--json]');
      expect(output.text()).toContain('happier session status <session-id-or-prefix> [--live] [--json]');
      expect(output.text()).toContain('happier session create [--path <path>] [--backend <backend-target>] [--tag <tag>] [--title <title>] [--prompt <text>|--message <text>] [--json]');
      expect(output.text()).toContain('happier session send <session-id-or-prefix> <message> [--permission-mode <mode>] [--model <model-id>] [--wait] [--timeout <seconds>] [--json]');
      expect(output.text()).toContain('happier session wait <session-id-or-prefix> [--timeout <seconds>] [--json]');
      expect(output.text()).toContain('happier session stop <session-id-or-prefix> [--json]');
      expect(output.text()).toContain('happier session set-title <session-id-or-prefix> <title> [--json]');
      expect(output.text()).toContain('happier session set-permission-mode <session-id-or-prefix> <mode> [--json]');
      expect(output.text()).toContain('happier session set-model <session-id-or-prefix> <model-id> [--json]');
      expect(output.text()).toContain('happier session archive <session-id-or-prefix> [--json]');
      expect(output.text()).toContain('happier session unarchive <session-id-or-prefix> [--json]');
      expect(output.text()).toContain('happier session history <session-id-or-prefix> [--limit N] [--format compact|raw] [--include-meta] [--include-structured-payload] [--json]');
      expect(output.text()).toContain('happier session actions list [--json]');
      expect(output.text()).toContain('happier session actions describe <action-id> [--json]');
      expect(output.text()).toContain('happier session actions execute <session-id> <action-id> [--input-json <json>] [--json]');
      expect(output.text()).toContain('happier session run start <session-id> --intent <intent> --backend <backend-target> [--json]');
      expect(output.text()).toContain('happier session run send <session-id> <run-id> <message> [--resume] [--json]');
      expect(output.text()).toContain('happier session run stop <session-id> <run-id> [--json]');
      expect(output.text()).toContain('happier session run action <session-id> <run-id> <action-id> [--input-json <json>] [--json]');
      expect(output.text()).toContain('happier session run wait <session-id> <run-id> [--timeout <seconds>] [--json]');
    } finally {
      output.restore();
    }
  });

  it.each([
    ['list', 'happier session list [--active] [--archived] [--limit N] [--cursor C] [--include-system] [--resumable] [--plain] [--json]'],
    ['status', 'happier session status <session-id-or-prefix> [--live] [--json]'],
    ['send', 'happier session send <session-id-or-prefix> <message> [--permission-mode <mode>] [--model <model-id>] [--wait] [--timeout <seconds>] [--json]'],
    ['set-title', 'happier session set-title <session-id-or-prefix> <title> [--json]'],
    ['set-permission-mode', 'happier session set-permission-mode <session-id-or-prefix> <mode> [--json]'],
    ['set-model', 'happier session set-model <session-id-or-prefix> <model-id> [--json]'],
  ] as const)('prints usage for `%s --help` without prompting for credentials', async (subcommand, expectedUsage) => {
    const { handleSessionCommand } = await import('./handleSessionCommand');
    const output = captureConsoleText();

    try {
      await handleSessionCommand([subcommand, '--help']);

      expect(output.text()).toContain(expectedUsage);
      expect(output.text()).not.toContain('Not authenticated');
    } finally {
      output.restore();
    }
  });
});
