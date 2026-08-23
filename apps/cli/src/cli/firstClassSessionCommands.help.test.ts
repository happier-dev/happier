import { describe, expect, it } from 'vitest';

import { captureConsoleText } from '@/testkit/logger/captureOutput';

import { FIRST_CLASS_SESSION_COMMANDS } from './firstClassSessionCommands';

describe('first-class CLI session command help', () => {
  it('renders each command with its invoked top-level command', async () => {
    for (const sessionCommand of FIRST_CLASS_SESSION_COMMANDS) {
      const output = captureConsoleText();
      try {
        await sessionCommand.handler({
          args: [sessionCommand.command, '--help'],
          rawArgv: ['happier', sessionCommand.command, '--help'],
          terminalRuntime: null,
        });

        expect(output.text().startsWith(`happier ${sessionCommand.command}`)).toBe(true);
        expect(output.text()).not.toContain('happier session');
      } finally {
        output.restore();
      }
    }
  });

  it('scopes finite history limits to the snapshot alternative from the canonical help owner', async () => {
    const history = FIRST_CLASS_SESSION_COMMANDS.find((sessionCommand) => sessionCommand.command === 'history');
    expect(history).toBeDefined();
    const output = captureConsoleText();
    try {
      await history!.handler({
        args: ['history', '--help'],
        rawArgv: ['happier', 'history', '--help'],
        terminalRuntime: null,
      });

      expect(output.text()).toContain('happier history <session-id-or-prefix-or-tag> ([--tail N|--limit N]');
      expect(output.text()).toContain('| --follow [--jsonl])');
    } finally {
      output.restore();
    }
  });
});
