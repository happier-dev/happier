import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageBuffer } from '@/ui/ink/messageBuffer';

import { createCodexRemoteTerminalUi } from './createCodexRemoteTerminalUi';

class FakeInputStream extends EventEmitter {
  public isTTY = true;
  public rawModeChanges: boolean[] = [];
  public resumed = false;
  public paused = false;
  public encoding: BufferEncoding | null = null;

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
