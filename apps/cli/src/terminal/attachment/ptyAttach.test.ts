import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { runPtyAttach } from './ptyAttach';

function terminal() {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true, isRaw: false, rawModes: [] as boolean[],
    setRawMode(mode: boolean) { this.rawModes.push(mode); this.isRaw = mode; return this; },
    resume() { return this; }, pause() { return this; },
  });
  const written: Buffer[] = [];
  const stdout = Object.assign(new EventEmitter(), { columns: 100, rows: 30, write(chunk: Buffer) { written.push(Buffer.from(chunk)); return true; } });
  const stderr = { lines: [] as string[], write(line: string) { this.lines.push(line); return true; } };
  return { stdin, stdout, stderr, written };
}

describe('runPtyAttach', () => {
  it('starts at the live end, nudges a repaint, passes Ctrl-C through, and detaches on Ctrl-] leaving the Session running', async () => {
    const io = terminal();
    const calls: Array<[string, unknown]> = [];
    let reads = 0;
    const call = async (op: string, request: unknown, signal?: AbortSignal): Promise<unknown> => {
      calls.push([op, request]);
      if (op === 'open') return { ok: true, terminalId: 't-1', byteOffset: 40 };
      if (op === 'read') {
        reads += 1;
        if (reads === 1) return { ok: true, terminalId: 't-1', nextByteOffset: 45, availableByteOffset: 45, droppedBeforeByteOffset: 0, done: false,
          frames: [{ t: 'bytes', terminalId: 't-1', seq: 0, byteOffset: 40, byteLength: 5, encoding: 'base64', data: Buffer.from('hello').toString('base64') }] };
        // Idle: held until this viewer leaves.
        return await new Promise(resolve => signal?.addEventListener('abort', () => resolve({ ok: false, code: 'aborted', message: 'aborted' })));
      }
      return { ok: true };
    };
    const attached = runPtyAttach({ sessionId: 's-1' }, { call, stdin: io.stdin as never, stdout: io.stdout as never, stderr: io.stderr });
    await new Promise(resolve => setTimeout(resolve, 10));
    io.stdin.emit('data', Buffer.from('ab\u0003'));
    io.stdin.emit('data', Buffer.from('x\u001dignored'));
    await expect(attached).resolves.toBe(0);

    expect(Buffer.concat(io.written).toString()).toBe('hello');
    const viewerId = (calls[0]![1] as { viewerId: string }).viewerId;
    expect(calls.filter(([op]) => op === 'read').map(([, request]) => (request as { byteOffset: number }).byteOffset)).toEqual([40, 45]);
    expect(calls.filter(([op]) => op === 'input').map(([, request]) => (request as { event: unknown }).event)).toEqual([
      { t: 'resize', cols: 100, rows: 29 }, { t: 'resize', cols: 100, rows: 30 },
      { t: 'text', text: 'ab\u0003' }, { t: 'text', text: 'x' },
    ]);
    expect(calls.at(-1)).toEqual(['detach', { terminalId: 't-1', viewerId }]);
    expect(io.stdin.rawModes).toEqual([true, false]);
    expect(io.stderr.lines.join('')).toContain('detached');
  });

  it('restores the viewer size only after the Agent redrew for the nudge', async () => {
    // Two back-to-back resizes can leave a Windows console TUI at the nudged size (live windows2:
    // 'TUI 100x29' for a 30-row viewer); the restore follows the Agent's repaint instead.
    const io = terminal();
    const events: string[] = [];
    let nudged!: () => void;
    const nudge = new Promise<void>(resolve => { nudged = resolve; });
    let reads = 0;
    const call = async (op: string, request: unknown, signal?: AbortSignal): Promise<unknown> => {
      if (op === 'open') return { ok: true, terminalId: 't-1', byteOffset: 0 };
      if (op === 'input') {
        const event = (request as { event: { t: string; rows?: number } }).event;
        if (event.t === 'resize') { events.push(`resize ${event.rows}`); if (event.rows === 29) nudged(); }
        return { ok: true };
      }
      if (op === 'read') {
        reads += 1;
        if (reads === 1) {
          await nudge;
          await new Promise(resolve => setTimeout(resolve, 20));
          events.push('redraw read');
          return { ok: true, terminalId: 't-1', nextByteOffset: 6, availableByteOffset: 6, droppedBeforeByteOffset: 0, done: false,
            frames: [{ t: 'bytes', terminalId: 't-1', seq: 0, byteOffset: 0, byteLength: 6, encoding: 'base64', data: Buffer.from('redraw').toString('base64') }] };
        }
        return await new Promise(resolve => signal?.addEventListener('abort', () => resolve({ ok: false, code: 'aborted', message: 'aborted' })));
      }
      return { ok: true };
    };
    const attached = runPtyAttach({ sessionId: 's-1' }, { call, stdin: io.stdin as never, stdout: io.stdout as never, stderr: io.stderr });
    await new Promise(resolve => setTimeout(resolve, 80));
    io.stdin.emit('data', Buffer.from('\u001d'));
    await expect(attached).resolves.toBe(0);
    expect(events).toEqual(['resize 29', 'redraw read', 'resize 30']);
  });

  it('refuses with a typed reason when the Session has no live Agent terminal', async () => {
    const io = terminal();
    const code = await runPtyAttach({ sessionId: 's-1' }, { call: async () => ({ ok: false, code: 'agent_terminal_unavailable', message: 'none' }),
      stdin: io.stdin as never, stdout: io.stdout as never, stderr: io.stderr });
    expect(code).toBe(1);
    expect(io.stdin.rawModes).toEqual([]);
    expect(io.stderr.lines.join('')).toContain('try again');
  });
});
