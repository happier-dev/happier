import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import type { TerminalInputEvent } from '@happier-dev/protocol/terminal';

import { daemonPost } from '@/daemon/controlHttp';
import { SESSION_AGENT_TERMINAL_PATH } from '@/daemon/sessionAgentTerminalRoute';

/** Ctrl-] detaches (telnet's escape key): Claude's TUI binds no action to it. */
export const PTY_ATTACH_DETACH_BYTE = 0x1d;

type Op = 'open' | 'read' | 'input' | 'detach';
type Refusal = Readonly<{ ok: false; code: string; message: string }>;

export type PtyAttachDeps = Readonly<{
  /** One call on the Session's Agent terminal (default: the daemon's attach route). */
  call?: (op: Op, request: unknown, signal?: AbortSignal) => Promise<unknown>;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
  stderr?: Pick<NodeJS.WriteStream, 'write'>;
}>;

function viaDaemon(sessionId: string) {
  return async (op: Op, request: unknown, signal?: AbortSignal): Promise<unknown> => {
    const result = await daemonPost(SESSION_AGENT_TERMINAL_PATH, { sessionId, op, request }, { timeoutMs: null, ...(signal ? { signal } : {}) });
    if (result && typeof result === 'object' && 'error' in result && !('ok' in result)) {
      return { ok: false, code: 'daemon_unavailable', message: String((result as { error: unknown }).error) } satisfies Refusal;
    }
    return result;
  };
}

function refused(value: unknown): value is Refusal {
  return !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === false;
}

/**
 * `happier attach` on a Holder-PTY Session: this terminal becomes a viewer of the Agent's terminal
 * through the process holding the Session (never a connection to the holder). It starts at the live
 * end of the output, makes the TUI repaint by a resize nudge, and the most recently active viewer
 * sets the size. Ctrl-] detaches; the Session keeps running. Ends when the Agent ends.
 */
export async function runPtyAttach(params: Readonly<{ sessionId: string }>, deps: PtyAttachDeps = {}): Promise<number> {
  const call = deps.call ?? viaDaemon(params.sessionId);
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const viewerId = randomUUID();
  const opened = await call('open', { viewerId });
  if (refused(opened)) {
    stderr.write(`Cannot attach: ${opened.message}${opened.code === 'agent_terminal_unavailable' ? ' (if its runner is restarting, try again)' : ''}\n`);
    return 1;
  }
  const { terminalId, byteOffset } = opened as { terminalId: string; byteOffset: number };
  const input = (event: TerminalInputEvent) => call('input', { terminalId, viewerId, event });
  const reading = new AbortController();
  let detached = false;
  let finish!: (code: number) => void;
  const finished = new Promise<number>(resolve => { finish = resolve; });

  const size = () => ({ cols: Math.max(2, stdout.columns || 80), rows: Math.max(2, stdout.rows || 24) });
  const onResize = () => { void input({ t: 'resize', ...size() }); };
  const onInput = (chunk: Buffer | string) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    const chord = bytes.indexOf(PTY_ATTACH_DETACH_BYTE);
    const typed = chord < 0 ? bytes : bytes.subarray(0, chord);
    if (typed.length) void input({ t: 'text', text: typed.toString('utf8') });
    if (chord >= 0) { detached = true; finish(0); }
  };
  const wasRaw = stdin.isTTY ? stdin.isRaw : false;
  // Raw: every key (Ctrl-C included) goes to the Agent.
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.on('data', onInput);
  stdin.resume();
  stdout.on('resize', onResize);

  const readLoop = async () => {
    let offset = byteOffset;
    while (!reading.signal.aborted) {
      const response = await call('read', { terminalId, byteOffset: offset, holdForOutput: true }, reading.signal);
      if (reading.signal.aborted) return;
      if (refused(response)) {
        stderr.write(`\r\nAgent terminal unavailable: ${response.message}\r\n`);
        finish(1);
        return;
      }
      const read = response as { frames: Array<{ t: string; data?: string }>; nextByteOffset: number; done: boolean };
      for (const frame of read.frames) {
        if (frame.t === 'bytes' && frame.data) stdout.write(Buffer.from(frame.data, 'base64'));
      }
      offset = read.nextByteOffset;
      if (read.done) { finish(0); return; }
    }
  };
  void readLoop().catch(() => finish(1));
  // Restore step: one row less and back, so the TUI repaints its whole screen for this viewer.
  const { cols, rows } = size();
  if (rows > 2) await input({ t: 'resize', cols, rows: rows - 1 });
  await input({ t: 'resize', cols, rows });

  const code = await finished;
  reading.abort();
  stdin.off('data', onInput);
  stdout.off('resize', onResize);
  if (stdin.isTTY) stdin.setRawMode(wasRaw);
  stdin.pause();
  await call('detach', { terminalId, viewerId }).catch(() => undefined);
  if (detached) stderr.write('\r\n[detached; the Session keeps running]\r\n');
  return code;
}
