import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

// Ink owns the terminal-rendering boundary; the probe records when the module is first loaded.
const inkProbe = vi.hoisted(() => ({
  loaded: false,
  render: null as null | ReturnType<typeof vi.fn>,
}));
vi.mock('ink', async (importOriginal) => {
  inkProbe.loaded = true;
  const actual = await importOriginal<typeof import('ink')>();
  inkProbe.render = vi.fn(() => ({ unmount: vi.fn(), rerender: vi.fn() }));
  return { ...actual, render: inkProbe.render };
});

import { createCodexRemoteTerminalUi } from './createCodexRemoteTerminalUi';

class FakeInputStream extends EventEmitter {
  public isTTY = true;
  public rawModeChanges: boolean[] = [];
  public resumed = false;
  public paused = false;
  public encoding: BufferEncoding | null = null;

  resume(): this {
    this.resumed = true;
    this.paused = false;
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
  public chunks: string[] = [];

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

describe('createCodexRemoteTerminalUi', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads Ink only when the ink surface is first mounted', async () => {
    const stdin = new FakeInputStream();
    const ui = createCodexRemoteTerminalUi({
      messageBuffer: new MessageBuffer(),
      hasTTY: true,
      surface: 'ink',
      stdin: asReadStream(stdin),
      onExit: vi.fn(),
      onSwitchToLocal: vi.fn(),
    });
    await vi.dynamicImportSettled();
    expect(inkProbe.loaded).toBe(false);

    ui.mount();
    await vi.waitFor(() => expect(inkProbe.render).toHaveBeenCalledTimes(1));
    expect(stdin.rawModeChanges).toEqual([true]);

    await ui.unmount();
  });

  it('does not render Ink when unmounted before the first load finishes', async () => {
    const stdin = new FakeInputStream();
    const ui = createCodexRemoteTerminalUi({
      messageBuffer: new MessageBuffer(),
      hasTTY: true,
      surface: 'ink',
      stdin: asReadStream(stdin),
      onExit: vi.fn(),
      onSwitchToLocal: vi.fn(),
    });
    inkProbe.render?.mockClear();

    ui.mount();
    await ui.unmount();
    await vi.dynamicImportSettled();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(inkProbe.render ?? vi.fn()).not.toHaveBeenCalled();
    expect(stdin.rawModeChanges).not.toContain(true);
  });

  it('keeps stdin live when remounted while an unmount is still draining input', async () => {
    const stdin = new FakeInputStream();
    const ui = createCodexRemoteTerminalUi({
      messageBuffer: new MessageBuffer(),
      hasTTY: true,
      surface: 'ink',
      stdin: asReadStream(stdin),
      onExit: vi.fn(),
      onSwitchToLocal: vi.fn(),
    });
    inkProbe.render?.mockClear();

    ui.mount();
    const unmounting = ui.unmount();
    ui.mount();
    await unmounting;
    await vi.waitFor(() => expect(inkProbe.render).toHaveBeenCalledTimes(1));

    expect(stdin.paused).toBe(false);
    expect(stdin.rawModeChanges.at(-1)).toBe(true);

    await ui.unmount();
  });

  it('contains a failed Ink render instead of rejecting unobserved', async () => {
    const stdin = new FakeInputStream();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const ui = createCodexRemoteTerminalUi({
        messageBuffer: new MessageBuffer(),
        hasTTY: true,
        surface: 'ink',
        stdin: asReadStream(stdin),
        onExit: vi.fn(),
        onSwitchToLocal: vi.fn(),
      });
      await import('ink');
      inkProbe.render!.mockClear();
      inkProbe.render!.mockImplementationOnce(() => {
        throw new Error('render failed');
      });

      ui.mount();
      await vi.waitFor(() => expect(inkProbe.render).toHaveBeenCalledTimes(1));
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('uses the static remote-control surface for daemon-started tmux sessions', async () => {
    vi.useFakeTimers();
    const stdin = new FakeInputStream();
    const stdout = new FakeOutputStream();
    const onSwitchToLocal = vi.fn();

    const params: Parameters<typeof createCodexRemoteTerminalUi>[0] & {
      surface: 'static';
      stdout: NodeJS.WriteStream;
    } = {
      messageBuffer: new MessageBuffer(),
      hasTTY: false,
      surface: 'static',
      stdin: asReadStream(stdin),
      stdout: asWriteStream(stdout),
      onExit: vi.fn(),
      onSwitchToLocal,
    };
    const ui = createCodexRemoteTerminalUi(params);

    ui.setAllowSwitchToLocal(true);
    ui.mount();

    expect(stdout.text()).toContain('Remote session running');
    expect(stdout.text()).toContain('Ctrl-T');

    stdin.emit('data', '\u0014');
    await vi.advanceTimersByTimeAsync(100);
    expect(onSwitchToLocal).toHaveBeenCalledTimes(1);

    await ui.unmount();
    expect(stdin.rawModeChanges).toEqual([true, false]);
  });
});
