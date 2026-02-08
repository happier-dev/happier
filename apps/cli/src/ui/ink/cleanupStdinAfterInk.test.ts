import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupStdinAfterInk } from './cleanupStdinAfterInk';

type DataListener = (chunk: unknown) => void;
type StdinCallName = 'on' | 'off' | 'resume' | 'pause' | 'setRawMode';

interface FakeStdin {
  isTTY: boolean;
  on: (event: 'data', fn: DataListener) => FakeStdin;
  off: (event: 'data', fn: DataListener) => FakeStdin;
  resume: () => void;
  pause: () => void;
  setRawMode: (value: boolean) => void;
  __calls: Array<{ name: StdinCallName; args: unknown[] }>;
  __listenerCount: (event: 'data') => number;
}

function createFakeStdin(): FakeStdin {
  const listeners = new Map<'data', Set<DataListener>>();
  const calls: Array<{ name: StdinCallName; args: unknown[] }> = [];

  const api: FakeStdin = {
    isTTY: true,
    on: (event, fn) => {
      calls.push({ name: 'on', args: [event] });
      const set = listeners.get(event) ?? new Set<DataListener>();
      set.add(fn);
      listeners.set(event, set);
      return api;
    },
    off: (event, fn) => {
      calls.push({ name: 'off', args: [event] });
      listeners.get(event)?.delete(fn);
      return api;
    },
    resume: () => {
      calls.push({ name: 'resume', args: [] });
    },
    pause: () => {
      calls.push({ name: 'pause', args: [] });
    },
    setRawMode: (value: boolean) => {
      calls.push({ name: 'setRawMode', args: [value] });
    },
    __calls: calls,
    __listenerCount: (event: 'data') => listeners.get(event)?.size ?? 0,
  };

  return api;
}

describe('cleanupStdinAfterInk', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drains buffered input and pauses stdin', async () => {
    vi.useFakeTimers();
    const stdin = createFakeStdin();

    const promise = cleanupStdinAfterInk({ stdin, drainMs: 50 });
    expect(stdin.__listenerCount('data')).toBe(1);
    await vi.advanceTimersByTimeAsync(60);
    await promise;

    const callNames = stdin.__calls.map((call) => call.name);
    expect(callNames).toContain('setRawMode');
    expect(callNames).toContain('resume');
    expect(callNames).toContain('pause');
    expect(callNames.indexOf('resume')).toBeLessThan(callNames.indexOf('pause'));
    expect(stdin.__listenerCount('data')).toBe(0);
  });

  it('pauses immediately when drainMs is zero', async () => {
    const stdin = createFakeStdin();
    await cleanupStdinAfterInk({ stdin, drainMs: 0 });

    const callNames = stdin.__calls.map((call) => call.name);
    expect(callNames).toContain('pause');
    expect(callNames).not.toContain('resume');
    expect(callNames).not.toContain('on');
  });

  it('is a no-op when stdin is not a TTY', async () => {
    const stdin = createFakeStdin();
    stdin.isTTY = false;
    await cleanupStdinAfterInk({ stdin, drainMs: 50 });
    expect(stdin.__calls.length).toBe(0);
  });
});
