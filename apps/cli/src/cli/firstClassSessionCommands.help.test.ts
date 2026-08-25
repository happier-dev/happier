import { describe, expect, it } from 'vitest';

import { captureConsoleJsonOutput, captureConsoleText } from '@/testkit/logger/captureOutput';

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

  it.each([
    ['spawn', 'session_create'],
    ['list', 'session_list'],
    ['ls', 'session_list'],
    ['send', 'session_send'],
    ['history', 'session_history'],
    ['wait', 'session_wait'],
    ['stop', 'session_stop'],
    ['delegate', 'session_delegate_start'],
  ] as const)('keeps --json help parseable for %s', async (command, expectedKind) => {
    const sessionCommand = FIRST_CLASS_SESSION_COMMANDS.find((entry) => (
      entry.command === command || entry.aliases?.includes(command)
    ));
    expect(sessionCommand).toBeDefined();
    const output = captureConsoleJsonOutput<{
      v: number;
      ok: boolean;
      kind: string;
      data: { help: string };
    }>();
    try {
      await sessionCommand!.handler({
        args: [command, '--help', '--json'],
        rawArgv: ['happier', command, '--help', '--json'],
        terminalRuntime: null,
      });

      expect(output.json()).toMatchObject({
        v: 1,
        ok: true,
        kind: expectedKind,
        data: { help: expect.stringMatching(new RegExp(`^happier ${command}(?: |$)`)) },
      });
    } finally {
      output.restore();
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

      expect(output.text()).toContain('happier history <session-id-or-prefix-or-tag> ([--machine-id <machineId>] [--tail N|--limit N]');
      expect(output.text()).toContain('| --follow [--jsonl])');
    } finally {
      output.restore();
    }
  });

  it.each(['list', 'send', 'history', 'wait', 'stop', 'delegate'] as const)(
    'advertises the shared machine selector for %s',
    async (command) => {
      const sessionCommand = FIRST_CLASS_SESSION_COMMANDS.find((entry) => entry.command === command);
      expect(sessionCommand).toBeDefined();
      const output = captureConsoleText();
      try {
        await sessionCommand!.handler({
          args: [command, '--help'],
          rawArgv: ['happier', command, '--help'],
          terminalRuntime: null,
        });

        expect(output.text()).toContain('--machine-id <machineId>');
      } finally {
        output.restore();
      }
    },
  );
});
