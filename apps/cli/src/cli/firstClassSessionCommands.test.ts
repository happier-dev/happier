import { describe, expect, it, vi } from 'vitest';

const { handleSessionCliCommand } = vi.hoisted(() => ({
  handleSessionCliCommand: vi.fn(async () => undefined),
}));

vi.mock('./commands/session', () => ({ handleSessionCliCommand }));

import { FIRST_CLASS_SESSION_COMMANDS } from './firstClassSessionCommands';

describe('first-class CLI session commands', () => {
  it('delegates each command to the canonical nested session command', async () => {
    for (const sessionCommand of FIRST_CLASS_SESSION_COMMANDS) {
      handleSessionCliCommand.mockClear();
      await sessionCommand.handler({
        args: [sessionCommand.command, 'argument'],
        rawArgv: ['happier', sessionCommand.command, 'argument'],
        terminalRuntime: null,
      });

      expect(handleSessionCliCommand).toHaveBeenCalledWith(expect.objectContaining({
        args: ['session', ...sessionCommand.sessionPath, 'argument'],
      }));
    }
  });

  it('retains ls as the only list alias', () => {
    expect(FIRST_CLASS_SESSION_COMMANDS.find((sessionCommand) => sessionCommand.command === 'list')?.aliases).toEqual(['ls']);
  });

  it('projects spawn follow JSONL argv unchanged into the canonical create handler', async () => {
    const spawn = FIRST_CLASS_SESSION_COMMANDS.find((sessionCommand) => sessionCommand.command === 'spawn');
    expect(spawn).toBeDefined();

    await spawn!.handler({
      args: ['spawn', '--path', '/tmp/project', '--follow', '--jsonl'],
      rawArgv: ['happier', 'spawn', '--path', '/tmp/project', '--follow', '--jsonl'],
      terminalRuntime: null,
    });

    expect(handleSessionCliCommand).toHaveBeenCalledWith(expect.objectContaining({
      args: ['session', 'create', '--path', '/tmp/project', '--follow', '--jsonl'],
    }));
  });

  it('projects history --tail unchanged into the canonical history handler', async () => {
    const history = FIRST_CLASS_SESSION_COMMANDS.find((sessionCommand) => sessionCommand.command === 'history');
    expect(history).toBeDefined();

    await history!.handler({
      args: ['history', 'sess-1', '--tail', '10', '--json'],
      rawArgv: ['happier', 'history', 'sess-1', '--tail', '10', '--json'],
      terminalRuntime: null,
    });

    expect(handleSessionCliCommand).toHaveBeenCalledWith(expect.objectContaining({
      args: ['session', 'history', 'sess-1', '--tail', '10', '--json'],
    }));
  });

  it.each([
    ['spawn --timeout', 'spawn', ['--timeout', '5', '--json'], ['session', 'create', '--timeout', '5', '--json']],
    ['history --follow --limit', 'history', ['sess-1', '--follow', '--limit', '10', '--jsonl'], ['session', 'history', 'sess-1', '--follow', '--limit', '10', '--jsonl']],
  ])('projects %s unchanged into its canonical parser', async (_label, command, args, expectedArgs) => {
    const sessionCommand = FIRST_CLASS_SESSION_COMMANDS.find((entry) => entry.command === command);
    expect(sessionCommand).toBeDefined();

    await sessionCommand!.handler({
      args: [command, ...args],
      rawArgv: ['happier', command, ...args],
      terminalRuntime: null,
    });

    expect(handleSessionCliCommand).toHaveBeenLastCalledWith(expect.objectContaining({ args: expectedArgs }));
  });
});
