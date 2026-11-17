import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';

import type { RpcHandler } from '@/api/rpc/types';
import type { PtyExitEvent, PtyProcess, PtyProvider } from '@/terminal/pty/provider';
import { createTerminalPtySessionManager } from '@/terminal/pty/sessions';
import { registerSessionAgentTerminalHandlers } from './sessionAgentTerminal';

/** The PTY boundary: a TUI whose output the test writes and whose input and size it records. */
class AgentPty implements PtyProcess {
  readonly pid = 0;
  readonly writes: string[] = [];
  readonly sizes: Array<string> = [];
  killed = 0;
  private readonly data = new Set<(data: string | Buffer) => void>();
  private readonly exits = new Set<(event: PtyExitEvent) => void>();
  write(data: string) { this.writes.push(data); }
  resize(cols: number, rows: number) { this.sizes.push(`${cols}x${rows}`); }
  kill() { this.killed += 1; }
  onData(listener: (data: string) => void) { this.data.add(listener as never); return { dispose: () => { this.data.delete(listener as never); } }; }
  onExit(listener: (event: PtyExitEvent) => void) { this.exits.add(listener); return { dispose: () => { this.exits.delete(listener); } }; }
  emit(text: string) { for (const listener of this.data) listener(Buffer.from(text)); }
  exit() { for (const listener of this.exits) listener({ exitCode: 0 }); }
}

function setup() {
  const ptys: AgentPty[] = [];
  const provider: PtyProvider = { spawn: () => { const pty = new AgentPty(); ptys.push(pty); return pty; } };
  const manager = createTerminalPtySessionManager({ ptyProvider: provider, platform: 'linux', env: {},
    config: { bufferMaxBytes: 1_000_000, bufferMaxEvents: 1000, urlParseBufferLimit: 32_768, maxWriteChunkBytes: 16_384, defaultCols: 80, defaultRows: 24 } });
  const handlers = new Map<string, RpcHandler>();
  registerSessionAgentTerminalHandlers({ registerHandler: (method, handler) => { handlers.set(method, handler as RpcHandler); } },
    { sessionId: 'session-a', terminals: () => manager });
  const agent = { onOutput: () => {}, onExit: () => {}, onResize: () => {} };
  const start = (sessionId: string) => manager.ensure({ terminalKey: `host-${sessionId}`, sessionId, cwd: '/tmp', cols: 120, rows: 40,
    launchProcess: { file: 'agent', args: [], env: {} }, agent });
  const call = (method: string, request: unknown, signal = new AbortController().signal) =>
    handlers.get(method)!(request, { signal } as never) as Promise<Record<string, unknown>>;
  const text = (response: Record<string, unknown>) => Buffer.concat((response.frames as Array<{ t: string; data: string }>)
    .filter(frame => frame.t === 'bytes').map(frame => Buffer.from(frame.data, 'base64'))).toString();
  return { manager, ptys, start, call, text };
}

describe('Session Agent terminal attach RPC', () => {
  it('refuses a Session without a live Agent terminal and never reaches another Session\'s terminal', async () => {
    const { start, call } = setup();
    expect(await call(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_OPEN, { viewerId: 'v' })).toMatchObject({ ok: false, code: 'agent_terminal_unavailable' });
    const other = await start('session-b');
    if (!other.ok) throw new Error('start failed');
    expect(await call(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_OPEN, { viewerId: 'v' })).toMatchObject({ ok: false, code: 'agent_terminal_unavailable' });
    for (const [method, request] of [
      [SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_READ, { terminalId: other.terminalId, byteOffset: 0 }],
      [SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_INPUT, { terminalId: other.terminalId, viewerId: 'v', event: { t: 'text', text: 'x' } }],
      [SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_DETACH, { terminalId: other.terminalId, viewerId: 'v' }],
    ] as const) expect(await call(method, request)).toMatchObject({ ok: false, code: 'agent_terminal_unavailable' });
    expect(await call(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_OPEN, {})).toMatchObject({ ok: false, code: 'terminal_invalid_request' });
  });

  it('serves two viewers beside the controller from the live end, sizes for the latest active viewer, and detach leaves the Agent running', async () => {
    const { manager, ptys, start, call, text } = setup();
    const started = await start('session-a');
    if (!started.ok) throw new Error('start failed');
    const pty = ptys[0]!;
    pty.emit('history ');
    const first = await call(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_OPEN, { viewerId: 'one' });
    const second = await call(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_OPEN, { viewerId: 'two' });
    expect(first).toEqual({ ok: true, terminalId: started.terminalId, byteOffset: 8 });
    expect(second).toEqual(first);

    // A held read waits for output and gets exactly what followed its offset.
    const held = call(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_READ, { terminalId: started.terminalId, byteOffset: 8, holdForOutput: true });
    await new Promise(resolve => setTimeout(resolve, 10));
    pty.emit('frame-1 ');
    expect(text(await held)).toBe('frame-1 ');
    // The controller (the host's own input, no viewer) and both viewers type.
    expect(await manager.input({ terminalId: started.terminalId, data: 'c' })).toEqual({ ok: true });
    const input = (viewerId: string, event: unknown) => call(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_INPUT, { terminalId: started.terminalId, viewerId, event });
    expect(await input('one', { t: 'resize', cols: 200, rows: 50 })).toEqual({ ok: true });
    expect(await input('two', { t: 'resize', cols: 90, rows: 30 })).toEqual({ ok: true });
    expect(await input('one', { t: 'text', text: 'a' })).toEqual({ ok: true });
    expect(await input('two', { t: 'text', text: 'b' })).toEqual({ ok: true });
    pty.emit('frame-2');
    expect(pty.writes).toEqual(['c', 'a', 'b']);
    expect(pty.sizes).toEqual(['200x50', '90x30', '200x50', '90x30']);
    // Both viewers read the same bytes from the same offset: nothing lost, nothing twice.
    for (const viewer of [first, second]) {
      const read = await call(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_READ, { terminalId: started.terminalId, byteOffset: viewer.byteOffset });
      expect(text(read)).toBe('frame-1 frame-2');
    }
    expect(await call(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_DETACH, { terminalId: started.terminalId, viewerId: 'one' })).toEqual({ ok: true });
    expect(pty.killed).toBe(0);
    expect(manager.list().find(entry => entry.terminalId === started.terminalId)?.ended).toBe(false);
    // The Agent ends: a reader is told it is done.
    pty.exit();
    expect(await call(SESSION_RPC_METHODS.SESSION_AGENT_TERMINAL_READ, { terminalId: started.terminalId, byteOffset: 23, holdForOutput: true }))
      .toMatchObject({ ok: true, done: true });
    manager.dispose();
  });
});
