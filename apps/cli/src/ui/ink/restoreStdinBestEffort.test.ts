import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { restoreStdinBestEffort } from './restoreStdinBestEffort';

class FakeStdin extends EventEmitter {
  public isTTY = true;
  public setRawMode = vi.fn();
  public pause = vi.fn();
  public setEncoding = vi.fn();
}

describe('restoreStdinBestEffort', () => {
  it('removes data listeners, pauses, disables raw mode, and resets encoding', () => {
    const stdin = new FakeStdin();
    const onData = vi.fn();
    stdin.on('data', onData);
    expect(stdin.listenerCount('data')).toBe(1);

    restoreStdinBestEffort({ stdin: stdin as any });

    expect(stdin.setRawMode).toHaveBeenCalledWith(false);
    expect(stdin.pause).toHaveBeenCalled();
    expect(stdin.setEncoding).toHaveBeenCalledWith(null);
    expect(stdin.listenerCount('data')).toBe(0);
  });

  it('does not throw when stdin APIs are missing', () => {
    expect(() => restoreStdinBestEffort({ stdin: {} as any })).not.toThrow();
  });
});

