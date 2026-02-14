import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

class FakeStdout extends EventEmitter {
  writableNeedDrain = false;
  columns = 120;
  rows = 40;
  isTTY = true;

  writes: Array<{ chunk: unknown; encoding?: unknown }> = [];
  writeReturn = true;

  write(chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean {
    let encoding: unknown = undefined;
    let callback: (() => void) | undefined = undefined;

    if (typeof encodingOrCb === 'function') {
      callback = encodingOrCb as () => void;
    } else {
      encoding = encodingOrCb;
      if (typeof cb === 'function') callback = cb as () => void;
    }

    this.writes.push({ chunk, encoding });
    callback?.();
    return this.writeReturn;
  }
}

describe('createNonBlockingStdout', () => {
  it('passes writes through when not backpressured', async () => {
    const { createNonBlockingStdout } = await import('./nonBlockingStdout');
    const stdout = new FakeStdout();

    const wrapped = createNonBlockingStdout(stdout as any);
    const cb = vi.fn();
    const ok = (wrapped as any).write('hello', cb);

    expect(ok).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(stdout.writes.map((w) => String(w.chunk))).toEqual(['hello']);
    expect((wrapped as any).columns).toBe(120);
    expect((wrapped as any).rows).toBe(40);
    expect((wrapped as any).isTTY).toBe(true);
  });

  it('drops writes when writableNeedDrain is true (and still calls callback)', async () => {
    const { createNonBlockingStdout } = await import('./nonBlockingStdout');
    const stdout = new FakeStdout();
    stdout.writableNeedDrain = true;

    const wrapped = createNonBlockingStdout(stdout as any);
    const cb = vi.fn();
    const ok = (wrapped as any).write('dropped', cb);

    expect(ok).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(stdout.writes).toEqual([]);
  });

  it('drops writes after write() returns false until drain is observed', async () => {
    const { createNonBlockingStdout } = await import('./nonBlockingStdout');
    const stdout = new FakeStdout();
    stdout.writeReturn = false;

    const wrapped = createNonBlockingStdout(stdout as any);
    expect((wrapped as any).write('first')).toBe(false);
    expect(stdout.writes.map((w) => String(w.chunk))).toEqual(['first']);

    const cb = vi.fn();
    stdout.writeReturn = true;
    expect((wrapped as any).write('dropped', cb)).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(stdout.writes.map((w) => String(w.chunk))).toEqual(['first']);

    stdout.emit('drain');
    expect((wrapped as any).write('after-drain')).toBe(true);
    expect(stdout.writes.map((w) => String(w.chunk))).toEqual(['first', 'after-drain']);
  });

  it('does not register multiple drain listeners while already dropping', async () => {
    const { createNonBlockingStdout } = await import('./nonBlockingStdout');
    const stdout = new FakeStdout();
    const onceSpy = vi.spyOn(stdout, 'once');

    stdout.writeReturn = false;
    const wrapped = createNonBlockingStdout(stdout as any);

    (wrapped as any).write('first');
    (wrapped as any).write('second');
    (wrapped as any).write('third');

    const drainListeners = onceSpy.mock.calls.filter((c) => c[0] === 'drain');
    expect(drainListeners).toHaveLength(1);
  });
});

