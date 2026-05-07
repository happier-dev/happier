import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRemoteModeControlController,
  formatRemoteModeStaticBanner,
  resolveRemoteModeControlSurface,
  startRemoteModeStaticControl,
} from './remoteModeControl';

class FakeInputStream extends EventEmitter {
  public isTTY = true;
  public resumed = false;
  public paused = false;
  public encoding: BufferEncoding | null = null;
  public rawModeChanges: boolean[] = [];

  resume(): this {
    this.resumed = true;
    return this;
  }

  pause(): this {
    this.paused = true;
    return this;
  }

  setRawMode(value: boolean): this {
    this.rawModeChanges.push(value);
    return this;
  }

  setEncoding(value: BufferEncoding): this {
    this.encoding = value;
    return this;
  }
}

class FakeOutputStream {
  public readonly chunks: string[] = [];

  write(chunk: string | Uint8Array): boolean {
    this.chunks.push(String(chunk));
    return true;
  }

  text(): string {
    return this.chunks.join('');
  }
}

function asReadStream(stream: FakeInputStream): NodeJS.ReadStream {
  // Test fixture for the Node stdin boundary; production code only needs the ReadStream surface.
  return stream as unknown as NodeJS.ReadStream;
}

function asWriteStream(stream: FakeOutputStream): NodeJS.WriteStream {
  // Test fixture for the Node stdout boundary; production code only needs write().
  return stream as unknown as NodeJS.WriteStream;
}

describe('resolveRemoteModeControlSurface', () => {
  it('uses a static control surface for daemon-started tmux sessions with a TTY', () => {
    expect(
      resolveRemoteModeControlSurface({
        stdoutIsTTY: true,
        stdinIsTTY: true,
        startedBy: 'daemon',
        terminalMode: 'tmux',
      }),
    ).toBe('static');
  });

  it('keeps daemon-started plain sessions non-interactive', () => {
    expect(
      resolveRemoteModeControlSurface({
        stdoutIsTTY: true,
        stdinIsTTY: true,
        startedBy: 'daemon',
        terminalMode: 'plain',
      }),
    ).toBe('none');
  });

  it('uses Ink for terminal-started sessions with a TTY', () => {
    expect(
      resolveRemoteModeControlSurface({
        stdoutIsTTY: true,
        stdinIsTTY: true,
        startedBy: 'terminal',
        terminalMode: 'tmux',
      }),
    ).toBe('ink');
  });
});

describe('createRemoteModeControlController', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('switches to local mode on Ctrl-T without Ink', async () => {
    vi.useFakeTimers();
    const onSwitchToLocal = vi.fn();
    const controller = createRemoteModeControlController({
      allowSwitchToLocal: true,
      onSwitchToLocal,
      onExit: vi.fn(),
    });

    controller.handleKeypress('t', { ctrl: true });

    expect(controller.getSnapshot().actionInProgress).toBe('switching');
    await vi.advanceTimersByTimeAsync(100);
    expect(onSwitchToLocal).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('requires double space before switching to local mode', async () => {
    vi.useFakeTimers();
    const onSwitchToLocal = vi.fn();
    const controller = createRemoteModeControlController({
      allowSwitchToLocal: true,
      onSwitchToLocal,
      onExit: vi.fn(),
    });

    controller.handleKeypress(' ', {});
    expect(controller.getSnapshot().confirmationMode).toBe('switch');
    await vi.advanceTimersByTimeAsync(100);
    expect(onSwitchToLocal).not.toHaveBeenCalled();

    controller.handleKeypress(' ', {});
    expect(controller.getSnapshot().actionInProgress).toBe('switching');
    await vi.advanceTimersByTimeAsync(100);
    expect(onSwitchToLocal).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('requires double Ctrl-C before exiting', async () => {
    vi.useFakeTimers();
    const onExit = vi.fn();
    const controller = createRemoteModeControlController({
      allowSwitchToLocal: true,
      onSwitchToLocal: vi.fn(),
      onExit,
    });

    controller.handleKeypress('c', { ctrl: true });
    expect(controller.getSnapshot().confirmationMode).toBe('exit');
    await vi.advanceTimersByTimeAsync(100);
    expect(onExit).not.toHaveBeenCalled();

    controller.handleKeypress('c', { ctrl: true });
    expect(controller.getSnapshot().actionInProgress).toBe('exiting');
    await vi.advanceTimersByTimeAsync(100);
    expect(onExit).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});

describe('startRemoteModeStaticControl', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('writes a static banner and handles keypresses through stdin', async () => {
    vi.useFakeTimers();
    const stdin = new FakeInputStream();
    const stdout = new FakeOutputStream();
    const onSwitchToLocal = vi.fn();

    const control = startRemoteModeStaticControl({
      providerName: 'Codex',
      stdin: asReadStream(stdin),
      stdout: asWriteStream(stdout),
      allowSwitchToLocal: true,
      onSwitchToLocal,
      onExit: vi.fn(),
    });

    expect(stdin.resumed).toBe(true);
    expect(stdin.encoding).toBe('utf8');
    expect(stdin.rawModeChanges).toEqual([true]);
    expect(stdout.text()).toContain('Remote session running');
    expect(stdout.text()).toContain('Ctrl-T');

    stdin.emit('data', '\u0014');
    await vi.advanceTimersByTimeAsync(100);

    expect(onSwitchToLocal).toHaveBeenCalledTimes(1);
    await control.stop();
    expect(stdin.rawModeChanges).toEqual([true, false]);
    expect(stdin.paused).toBe(true);
  });

  it('redraws the static banner when a tmux attach refresh key is received', async () => {
    const stdin = new FakeInputStream();
    const stdout = new FakeOutputStream();

    const control = startRemoteModeStaticControl({
      providerName: 'Claude',
      stdin: asReadStream(stdin),
      stdout: asWriteStream(stdout),
      allowSwitchToLocal: true,
      onSwitchToLocal: vi.fn(),
      onExit: vi.fn(),
    });

    const initialWrites = stdout.chunks.length;
    stdin.emit('data', '\u000c');

    expect(stdout.chunks.length).toBeGreaterThan(initialWrites);
    expect(stdout.text().match(/Remote session running/g)?.length).toBe(2);

    await control.stop();
  });
});

describe('formatRemoteModeStaticBanner', () => {
  it('includes local-switch instructions only when switching is enabled', () => {
    expect(formatRemoteModeStaticBanner({ providerName: 'Claude', allowSwitchToLocal: true })).toContain('Ctrl-T');
    expect(formatRemoteModeStaticBanner({ providerName: 'Claude', allowSwitchToLocal: false })).not.toContain('Ctrl-T');
  });
});
