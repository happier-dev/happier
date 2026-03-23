import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';

import type { DaemonTerminalErrorCode, DaemonTerminalStreamEvent } from '@happier-dev/protocol';

import type { Disposable, PtyProvider, PtyProcess } from './ptyProvider';
import { createTerminalUrlDetector } from './terminalUrlDetection';
import { resolveTerminalShell } from './terminalShellCandidates';

type ErrorResult = Readonly<{
  ok: false;
  errorCode: DaemonTerminalErrorCode;
  error: string;
}>;

type EnsureOk = Readonly<{ ok: true; terminalId: string; reused: boolean }>;
type ReadOk = Readonly<{ ok: true; terminalId: string; events: readonly DaemonTerminalStreamEvent[]; nextCursor: number; done: boolean }>;
type SimpleOk = Readonly<{ ok: true }>;

export type TerminalPtySessionManagerConfig = Readonly<{
  maxSessions: number;
  idleTimeoutMs: number;
  bufferMaxBytes: number;
  bufferMaxEvents: number;
  urlParseBufferLimit: number;
  maxWriteChunkBytes: number;
  defaultCols: number;
  defaultRows: number;
}>;

export type TerminalPtySessionManager = Readonly<{
  ensure: (input: Readonly<{ terminalKey: string; cwd: string; cols?: number; rows?: number; initialCommand?: string }>) => EnsureOk | ErrorResult;
  read: (input: Readonly<{ terminalId: string; cursor: number; maxBytes: number; maxEvents: number }>) => ReadOk | ErrorResult;
  input: (input: Readonly<{ terminalId: string; data: string }>) => SimpleOk | ErrorResult;
  resize: (input: Readonly<{ terminalId: string; cols: number; rows: number }>) => SimpleOk | ErrorResult;
  close: (input: Readonly<{ terminalId: string }>) => SimpleOk | ErrorResult;
  restart: (input: Readonly<{ terminalKey: string; cwd: string; cols?: number; rows?: number; initialCommand?: string }>) => EnsureOk | ErrorResult;
}>;

function okDisabled(errorCode: DaemonTerminalErrorCode): ErrorResult {
  return { ok: false, errorCode, error: errorCode };
}

type EventBuffer = {
  baseCursor: number;
  events: DaemonTerminalStreamEvent[];
  bytes: number;
};

function estimateEventBytes(event: DaemonTerminalStreamEvent): number {
  switch (event.t) {
    case 'data':
      return Buffer.byteLength(event.data ?? '', 'utf8');
    case 'url':
      return Buffer.byteLength(event.url ?? '', 'utf8') + 64;
    case 'gap':
      return 32;
    case 'exit':
      return 32;
  }
}

function pushEvent(buffer: EventBuffer, event: DaemonTerminalStreamEvent, limits: Pick<TerminalPtySessionManagerConfig, 'bufferMaxBytes' | 'bufferMaxEvents'>): void {
  buffer.events.push(event);
  buffer.bytes += estimateEventBytes(event);

  const maxEvents = Math.max(1, Math.trunc(limits.bufferMaxEvents));
  const maxBytes = Math.max(1, Math.trunc(limits.bufferMaxBytes));

  while (buffer.events.length > maxEvents || buffer.bytes > maxBytes) {
    const removed = buffer.events.shift();
    if (!removed) break;
    buffer.bytes -= estimateEventBytes(removed);
    buffer.baseCursor += 1;
  }
}

function readFromBuffer(params: Readonly<{
  buffer: EventBuffer;
  cursor: number;
  maxBytes: number;
  maxEvents: number;
  done: boolean;
}>): { events: readonly DaemonTerminalStreamEvent[]; nextCursor: number; done: boolean } {
  const buffer = params.buffer;
  const baseCursor = buffer.baseCursor;
  const requested = Math.max(0, Math.trunc(params.cursor));
  const effectiveCursor = Math.max(requested, baseCursor);
  const startIndex = effectiveCursor - baseCursor;

  const boundedMaxBytes = Math.max(1, Math.trunc(params.maxBytes));
  const boundedMaxEvents = Math.max(1, Math.trunc(params.maxEvents));

  const out: DaemonTerminalStreamEvent[] = [];
  let returnedStoredEvents = 0;
  let bytes = 0;

  if (requested < baseCursor) {
    out.push({ t: 'gap', droppedBefore: baseCursor });
  }

  for (let i = startIndex; i < buffer.events.length; i += 1) {
    const event = buffer.events[i]!;
    const eventBytes = estimateEventBytes(event);
    if (returnedStoredEvents >= boundedMaxEvents) break;
    if (returnedStoredEvents > 0 && bytes + eventBytes > boundedMaxBytes) break;
    out.push(event);
    returnedStoredEvents += 1;
    bytes += eventBytes;
    if (bytes >= boundedMaxBytes) break;
  }

  const nextCursor = effectiveCursor + returnedStoredEvents;
  const done = params.done && nextCursor >= baseCursor + buffer.events.length;
  return { events: out, nextCursor, done };
}

type PtySession = {
  terminalId: string;
  terminalKey: string;
  cwd: string;
  cols: number;
  rows: number;
  pty: PtyProcess;
  disposables: Disposable[];
  buffer: EventBuffer;
  ended: boolean;
  lastActivityAtMs: number;
  urlDetector: ReturnType<typeof createTerminalUrlDetector>;
};

function splitByApproxBytesUtf8(input: string, maxBytes: number): string[] {
  const safeMaxBytes = Math.max(1, Math.trunc(maxBytes));
  const out: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    let end = Math.min(input.length, cursor + safeMaxBytes);
    // Back off until the slice fits into maxBytes (UTF-8 byte length).
    while (end > cursor && Buffer.byteLength(input.slice(cursor, end), 'utf8') > safeMaxBytes) {
      end -= 1;
    }
    if (end <= cursor) {
      // Fallback: progress at least one code unit.
      end = Math.min(input.length, cursor + 1);
    }
    out.push(input.slice(cursor, end));
    cursor = end;
  }
  return out;
}

export function createTerminalPtySessionManager(params: Readonly<{
  ptyProvider: PtyProvider;
  config: TerminalPtySessionManagerConfig;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}>): TerminalPtySessionManager {
  const now = params.now ?? (() => Date.now());
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const config = params.config;

  const sessionsById = new Map<string, PtySession>();
  const terminalIdByKey = new Map<string, string>();

  const reapIdle = () => {
    const current = now();
    const timeoutMs = Math.max(0, Math.trunc(config.idleTimeoutMs));
    if (!timeoutMs) return;

    for (const [terminalId, session] of sessionsById) {
      if (current - session.lastActivityAtMs < timeoutMs) continue;
      try {
        session.pty.kill();
      } catch {
        // best-effort
      }
      for (const d of session.disposables) {
        try {
          d.dispose();
        } catch {
          // best-effort
        }
      }
      sessionsById.delete(terminalId);
      if (terminalIdByKey.get(session.terminalKey) === terminalId) {
        terminalIdByKey.delete(session.terminalKey);
      }
    }
  };

  const closeById = (terminalId: string): SimpleOk | ErrorResult => {
    reapIdle();
    const session = sessionsById.get(terminalId);
    if (!session) return okDisabled('terminal_not_found');
    try {
      session.pty.kill();
    } catch {
      // best-effort
    }
    for (const d of session.disposables) {
      try {
        d.dispose();
      } catch {
        // best-effort
      }
    }
    sessionsById.delete(terminalId);
    if (terminalIdByKey.get(session.terminalKey) === terminalId) {
      terminalIdByKey.delete(session.terminalKey);
    }
    return { ok: true };
  };

  const ensure = (input: Readonly<{ terminalKey: string; cwd: string; cols?: number; rows?: number; initialCommand?: string }>): EnsureOk | ErrorResult => {
    reapIdle();
    const existingId = terminalIdByKey.get(input.terminalKey) ?? null;
    if (existingId) {
      const existing = sessionsById.get(existingId);
      if (existing && !existing.ended) {
        existing.lastActivityAtMs = now();
        const cols = typeof input.cols === 'number' && Number.isFinite(input.cols) ? Math.max(2, Math.trunc(input.cols)) : existing.cols;
        const rows = typeof input.rows === 'number' && Number.isFinite(input.rows) ? Math.max(2, Math.trunc(input.rows)) : existing.rows;
        if (cols !== existing.cols || rows !== existing.rows) {
          try {
            existing.pty.resize(cols, rows);
            existing.cols = cols;
            existing.rows = rows;
          } catch {
            // ignore resize failures
          }
        }
        return { ok: true, terminalId: existingId, reused: true };
      }
    }

    // Enforce maxSessions by evicting the oldest idle session first.
    const maxSessions = Math.max(1, Math.trunc(config.maxSessions));
    if (sessionsById.size >= maxSessions) {
      let oldest: PtySession | null = null;
      for (const session of sessionsById.values()) {
        if (!oldest || session.lastActivityAtMs < oldest.lastActivityAtMs) {
          oldest = session;
        }
      }
      if (oldest) {
        closeById(oldest.terminalId);
      }
    }

    const terminalId = randomUUID();
    const cols = typeof input.cols === 'number' && Number.isFinite(input.cols) ? Math.max(2, Math.trunc(input.cols)) : config.defaultCols;
    const rows = typeof input.rows === 'number' && Number.isFinite(input.rows) ? Math.max(2, Math.trunc(input.rows)) : config.defaultRows;

    const shell = resolveTerminalShell(env, platform);

    let pty: PtyProcess;
    try {
      pty = params.ptyProvider.spawn({
        file: shell.file,
        args: shell.args.slice(),
        options: {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: input.cwd,
          env,
          encoding: 'utf8',
        },
      });
    } catch (error) {
      return okDisabled('terminal_spawn_failed');
    }

    const buffer: EventBuffer = { baseCursor: 0, events: [], bytes: 0 };
    const urlDetector = createTerminalUrlDetector({ bufferLimit: config.urlParseBufferLimit });
    const session: PtySession = {
      terminalId,
      terminalKey: input.terminalKey,
      cwd: input.cwd,
      cols,
      rows,
      pty,
      disposables: [],
      buffer,
      ended: false,
      lastActivityAtMs: now(),
      urlDetector,
    };

    session.disposables.push(
      pty.onData((data) => {
        session.lastActivityAtMs = now();
        const text = String(data ?? '');
        if (text) {
          const chunks = splitByApproxBytesUtf8(text, config.maxWriteChunkBytes);
          for (const chunk of chunks) {
            pushEvent(session.buffer, { t: 'data', data: chunk }, config);
          }
          const urls = urlDetector.ingest(text);
          for (const url of urls) {
            pushEvent(session.buffer, { t: 'url', ...url }, config);
          }
        }
      }),
    );

    session.disposables.push(
      pty.onExit((e) => {
        session.lastActivityAtMs = now();
        session.ended = true;
        pushEvent(session.buffer, { t: 'exit', exitCode: e.exitCode ?? null, signal: typeof e.signal === 'number' ? e.signal : null }, config);
      }),
    );

    sessionsById.set(terminalId, session);
    terminalIdByKey.set(input.terminalKey, terminalId);

    if (input.initialCommand && input.initialCommand.trim()) {
      const cmd = input.initialCommand.endsWith('\n') ? input.initialCommand : `${input.initialCommand}\n`;
      try {
        pty.write(cmd);
      } catch {
        // ignore
      }
    }

    return { ok: true, terminalId, reused: false };
  };

  const restart = (input: Readonly<{ terminalKey: string; cwd: string; cols?: number; rows?: number; initialCommand?: string }>): EnsureOk | ErrorResult => {
    reapIdle();
    const existing = terminalIdByKey.get(input.terminalKey) ?? null;
    if (existing) {
      closeById(existing);
    }
    return ensure({
      terminalKey: input.terminalKey,
      cwd: input.cwd,
      cols: input.cols,
      rows: input.rows,
      initialCommand: input.initialCommand,
    });
  };

  const read = (input: Readonly<{ terminalId: string; cursor: number; maxBytes: number; maxEvents: number }>): ReadOk | ErrorResult => {
    reapIdle();
    const session = sessionsById.get(input.terminalId);
    if (!session) return okDisabled('terminal_not_found');
    session.lastActivityAtMs = now();
    const { events, nextCursor, done } = readFromBuffer({
      buffer: session.buffer,
      cursor: input.cursor,
      maxBytes: input.maxBytes,
      maxEvents: input.maxEvents,
      done: session.ended,
    });
    return { ok: true, terminalId: input.terminalId, events, nextCursor, done };
  };

  const inputData = (input: Readonly<{ terminalId: string; data: string }>): SimpleOk | ErrorResult => {
    reapIdle();
    const session = sessionsById.get(input.terminalId);
    if (!session) return okDisabled('terminal_not_found');
    if (session.ended) return okDisabled('terminal_not_found');
    session.lastActivityAtMs = now();
    try {
      session.pty.write(String(input.data ?? ''));
    } catch {
      return okDisabled('terminal_not_found');
    }
    return { ok: true };
  };

  const resize = (input: Readonly<{ terminalId: string; cols: number; rows: number }>): SimpleOk | ErrorResult => {
    reapIdle();
    const session = sessionsById.get(input.terminalId);
    if (!session) return okDisabled('terminal_not_found');
    if (session.ended) return okDisabled('terminal_not_found');
    session.lastActivityAtMs = now();
    try {
      session.pty.resize(input.cols, input.rows);
      session.cols = input.cols;
      session.rows = input.rows;
      return { ok: true };
    } catch {
      return okDisabled('terminal_not_found');
    }
  };

  const close = (input: Readonly<{ terminalId: string }>): SimpleOk | ErrorResult => closeById(input.terminalId);

  return {
    ensure,
    restart,
    read,
    input: inputData,
    resize,
    close,
  };
}
