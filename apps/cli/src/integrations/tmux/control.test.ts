import { describe, expect, it } from 'vitest';

import type { TmuxCommandResult } from './types';
import { createTmuxTerminalControlPort, type TmuxControlCommandExecutor } from './control';

const TARGET = 'happy:claude.1';
const SHIFT_TAB = `${String.fromCharCode(0x1b)}[Z`;

function ok(stdout = ''): TmuxCommandResult {
  return { returncode: 0, stdout, stderr: '', command: [] };
}

function recordingExecutor(result: TmuxCommandResult | null = ok()): {
  executor: TmuxControlCommandExecutor;
  calls: string[][];
} {
  const calls: string[][] = [];
  const executor: TmuxControlCommandExecutor = async (args) => {
    calls.push([...args]);
    return result;
  };
  return { executor, calls };
}

describe('createTmuxTerminalControlPort', () => {
  it('exposes the tmux host kind', () => {
    const { executor } = recordingExecutor();
    expect(createTmuxTerminalControlPort({ executor, target: TARGET }).hostKind).toBe('tmux');
  });

  it('is a control-only surface that is NOT a prompt-injection surface (A6 fence)', () => {
    const { executor } = recordingExecutor();
    const port = createTmuxTerminalControlPort({ executor, target: TARGET });
    // Control code must never route `/model` etc. through injectUserPrompt; the port has no such method.
    expect('injectUserPrompt' in port).toBe(false);
    expect(typeof port.sendLiteralText).toBe('function');
    expect(typeof port.sendRawSequence).toBe('function');
    expect(typeof port.sendSpecialKey).toBe('function');
    expect(typeof port.captureScreen).toBe('function');
  });

  it('sends literal text via send-keys -l without submitting (no Enter/C-m)', async () => {
    const { executor, calls } = recordingExecutor();
    const port = createTmuxTerminalControlPort({ executor, target: TARGET });

    const result = await port.sendLiteralText('/model sonnet');

    expect(result.status).toBe('sent');
    expect(calls).toEqual([['send-keys', '-t', TARGET, '-l', '--', '/model sonnet']]);
    // No submit key may be appended by the literal-text primitive.
    expect(calls.flat()).not.toContain('C-m');
    expect(calls.flat()).not.toContain('Enter');
  });

  it('chunks literal text by the configured chunk size', async () => {
    const { executor, calls } = recordingExecutor();
    const port = createTmuxTerminalControlPort({ executor, target: TARGET, chunkSize: 3 });

    await port.sendLiteralText('abcdef');

    expect(calls).toEqual([
      ['send-keys', '-t', TARGET, '-l', '--', 'abc'],
      ['send-keys', '-t', TARGET, '-l', '--', 'def'],
    ]);
  });

  it('sends raw escape sequences literally via send-keys -l', async () => {
    const { executor, calls } = recordingExecutor();
    const port = createTmuxTerminalControlPort({ executor, target: TARGET });

    const result = await port.sendRawSequence(SHIFT_TAB);

    expect(result.status).toBe('sent');
    expect(calls).toEqual([['send-keys', '-t', TARGET, '-l', '--', SHIFT_TAB]]);
  });

  it('sends Enter and Escape as named keys', async () => {
    const { executor, calls } = recordingExecutor();
    const port = createTmuxTerminalControlPort({ executor, target: TARGET });

    await port.sendSpecialKey('Enter');
    await port.sendSpecialKey('Escape');

    expect(calls).toEqual([
      ['send-keys', '-t', TARGET, 'Enter'],
      ['send-keys', '-t', TARGET, 'Escape'],
    ]);
  });

  it('sends selection arrows as named keys', async () => {
    const { executor, calls } = recordingExecutor();
    const port = createTmuxTerminalControlPort({ executor, target: TARGET });

    await port.sendSpecialKey('ArrowUp');
    await port.sendSpecialKey('ArrowDown');

    expect(calls).toEqual([
      ['send-keys', '-t', TARGET, 'Up'],
      ['send-keys', '-t', TARGET, 'Down'],
    ]);
  });

  it('sends ShiftTab as the raw ESC [ Z sequence and NEVER a named S-Tab', async () => {
    const { executor, calls } = recordingExecutor();
    const port = createTmuxTerminalControlPort({ executor, target: TARGET });

    const result = await port.sendSpecialKey('ShiftTab');

    expect(result.status).toBe('sent');
    expect(calls).toEqual([['send-keys', '-t', TARGET, '-l', '--', SHIFT_TAB]]);
    // Hard fence: the named tmux key is a proven no-op and must never be emitted.
    expect(calls.flat()).not.toContain('S-Tab');
    expect(calls.flat().some((arg) => arg.includes('S-Tab'))).toBe(false);
  });

  it('captures the FULL pane (multi-line) and strips ANSI via the shared normalizer', async () => {
    const esc = String.fromCharCode(0x1b);
    const calls: string[][] = [];
    const executor: TmuxControlCommandExecutor = async (args) => {
      calls.push([...args]);
      if (args[0] === 'capture-pane') return ok(`${esc}[32mline1${esc}[0m\nline2\nline3   \n`);
      if (args[0] === 'display-message') return ok('2\t2\n');
      return ok();
    };
    const port = createTmuxTerminalControlPort({ executor, target: TARGET, nowMs: () => 4242 });

    const result = await port.captureScreen();

    expect(calls).toEqual([
      ['capture-pane', '-p', '-e', '-t', TARGET],
      ['display-message', '-p', '-t', TARGET, '#{cursor_x}\t#{cursor_y}'],
    ]);
    expect(result).toEqual({
      status: 'captured',
      capture: {
        text: 'line1\nline2\nline3',
        styledText: `${esc}[32mline1${esc}[0m\nline2\nline3   \n`,
        cursor: { x: 2, y: 2 },
        capturedAtMs: 4242,
        hostKind: 'tmux',
      },
    });
  });

  it('maps a missing tmux target to a typed non-recoverable host_dead result', async () => {
    const dead: TmuxCommandResult = { returncode: 1, stdout: '', stderr: "can't find pane: %3", command: [] };
    const { executor } = recordingExecutor(dead);
    const port = createTmuxTerminalControlPort({ executor, target: TARGET });

    await expect(port.sendLiteralText('x')).resolves.toEqual({ status: 'host_dead', recoverable: false });
    await expect(port.captureScreen()).resolves.toEqual({ status: 'host_dead', recoverable: false });
  });

  it('maps an unreachable host (null result) and a timeout to typed failures', async () => {
    const nullExec = recordingExecutor(null);
    const nullPort = createTmuxTerminalControlPort({ executor: nullExec.executor, target: TARGET });
    await expect(nullPort.sendLiteralText('x')).resolves.toEqual({
      status: 'failed',
      reason: 'host_unreachable',
    });

    const timedOut: TmuxCommandResult = { returncode: 1, stdout: '', stderr: '', command: [], timedOut: true };
    const timeoutExec = recordingExecutor(timedOut);
    const timeoutPort = createTmuxTerminalControlPort({ executor: timeoutExec.executor, target: TARGET });
    await expect(timeoutPort.sendRawSequence(SHIFT_TAB)).resolves.toEqual({
      status: 'failed',
      reason: 'timeout',
    });
  });
});
