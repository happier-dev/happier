import { Buffer } from 'node:buffer';
import { stripCliApiTokenEnvironment } from '@/auth/cliApiToken';
import { randomUUID } from 'node:crypto';

import {
  TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES,
  terminalInputEventToPtyAction,
} from '@happier-dev/protocol';
import type {
  DaemonTerminalErrorCode,
  DaemonTerminalStreamEvent,
  TerminalStreamInputRequest,
  TerminalStreamInputResponse,
} from '@happier-dev/protocol';

import type { TerminalProcessRegistry } from '@/daemon/local/services/inventory/terminalRegistry';

import { createTerminalByteRing, type TerminalByteRing, type TerminalByteRingChunk } from './byteRing';
import { normalizeByteOffset, normalizeLegacyCursor } from './cursors';
import { createUtf8StreamDecoder } from './decode';
import { createTerminalPtyMetrics, type TerminalPtyMetrics } from './metrics';
import type { Disposable, PtyProvider, PtyProcess } from './provider';
import type { TerminalLaunchProcess } from './launch';
import { resolveTerminalShell } from './shells';
import { createTerminalUrlDetector } from './urlDetection';

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
  bufferRetentionMs: number;
  urlParseBufferLimit: number;
  urlDedupeLimit?: number;
  maxWriteChunkBytes: number;
  defaultCols: number;
  defaultRows: number;
}>;

export type TerminalByteReadResult =
  | Readonly<{
      ok: true;
      terminalId: string;
      mode: 'bytes';
      chunks: readonly TerminalByteRingChunk[];
      nextByteOffset: number;
      availableByteOffset: number;
      droppedBeforeByteOffset: number;
      done: boolean;
      gap?: Readonly<{
        droppedBeforeByteOffset: number;
        nextAvailableByteOffset: number;
        reason: 'ring_overflow' | 'consumer_too_slow';
      }>;
      exit?: Readonly<{ exitCode: number | null; signal: number | null }>;
    }>
  | Readonly<{
      ok: true;
      terminalId: string;
      mode: 'legacyOnly';
      provider: 'windows-conpty' | 'python-relay' | 'unknown';
      reason: string;
      done: boolean;
    }>
  | ErrorResult;

export type TerminalByteStreamReadRequest = Readonly<{
  terminalId: string;
  byteOffset: number;
  ackedByteOffset?: number;
  creditBytes?: number;
  maxBytes?: number;
  maxFrames?: number;
  rendererId?: string;
  surfaceEpoch?: number;
}>;

export type TerminalByteStreamFrame =
  | Readonly<{
      t: 'bytes';
      terminalId: string;
      seq: number;
      byteOffset: number;
      byteLength: number;
      encoding: 'base64';
      data: string;
    }>
  | Readonly<{
      t: 'gap';
      terminalId: string;
      droppedBeforeByteOffset: number;
      nextAvailableByteOffset: number;
      reason: 'ring_overflow' | 'consumer_too_slow' | 'session_restarted';
    }>
  | Readonly<{
      t: 'legacyOnly';
      terminalId: string;
      provider: 'windows-conpty' | 'python-relay' | 'unknown';
      reason: string;
    }>
  | Readonly<{
      t: 'url';
      terminalId: string;
      byteOffset: number;
      url: string;
      kind: 'auth' | 'generic';
      suggestOpen?: boolean;
    }>
  | Readonly<{
      t: 'exit';
      terminalId: string;
      byteOffset: number;
      exitCode: number | null;
      signal: number | null;
    }>;

export type TerminalByteStreamReadResponse =
  | Readonly<{
      ok: true;
      terminalId: string;
      frames: TerminalByteStreamFrame[];
      nextByteOffset: number;
      availableByteOffset: number;
      droppedBeforeByteOffset: number;
      done: boolean;
    }>
  | Readonly<{ ok: false; code: string; message: string }>;

export type TerminalByteStreamAckRequest = Readonly<{
  terminalId: string;
  ackedByteOffset: number;
  rendererId?: string;
  surfaceEpoch?: number;
  creditBytes?: number;
}>;

export type TerminalByteStreamAckResponse = Readonly<{ ok: true }> | Readonly<{ ok: false; code: string; message: string }>;

export type TerminalPtySessionManager = Readonly<{
  ensure: (input: Readonly<{ terminalKey: string; cwd: string; cols?: number; rows?: number; initialCommand?: string; launchProcess?: TerminalLaunchProcess; sessionId?: string }>) => EnsureOk | ErrorResult;
  read: (input: Readonly<{ terminalId: string; cursor: number; maxBytes: number; maxEvents: number }>) => ReadOk | ErrorResult;
  readBytes: (input: Readonly<{ terminalId: string; byteOffset: number; maxBytes: number; maxChunks: number }>) => TerminalByteReadResult;
  readByteStream: (input: TerminalByteStreamReadRequest) => TerminalByteStreamReadResponse;
  acknowledgeByteStream: (input: TerminalByteStreamAckRequest) => TerminalByteStreamAckResponse;
  inputEvent: (input: TerminalStreamInputRequest) => TerminalStreamInputResponse;
  input: (input: Readonly<{ terminalId: string; data: string }>) => SimpleOk | ErrorResult;
  resize: (input: Readonly<{ terminalId: string; cols: number; rows: number }>) => SimpleOk | ErrorResult;
  close: (input: Readonly<{ terminalId: string }>) => SimpleOk | ErrorResult;
  restart: (input: Readonly<{ terminalKey: string; cwd: string; cols?: number; rows?: number; initialCommand?: string; launchProcess?: TerminalLaunchProcess; sessionId?: string }>) => EnsureOk | ErrorResult;
  metrics: () => ReturnType<TerminalPtyMetrics['snapshot']>;
}>;

function okDisabled(errorCode: DaemonTerminalErrorCode): ErrorResult {
  return { ok: false, errorCode, error: errorCode };
}

function isTerminalResizeUnavailableError(error: unknown): boolean {
  return error instanceof Error && error.message === 'terminal_resize_unavailable';
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
  const requested = normalizeLegacyCursor(params.cursor);
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

type ByteMode =
  | Readonly<{ kind: 'bytes' }>
  | Readonly<{ kind: 'legacyOnly'; provider: 'windows-conpty' | 'python-relay' | 'unknown'; reason: string }>;

type PtySession = {
  terminalId: string;
  terminalKey: string;
  cwd: string;
  sessionId?: string;
  cols: number;
  rows: number;
  pty: PtyProcess;
  disposables: Disposable[];
  buffer: EventBuffer;
  byteRing: TerminalByteRing;
  byteMode: ByteMode;
  ended: boolean;
  exit: Readonly<{ exitCode: number | null; signal: number | null }> | null;
  lastActivityAtMs: number;
  urlDetector: ReturnType<typeof createTerminalUrlDetector>;
  decoder: ReturnType<typeof createUtf8StreamDecoder>;
  controlFrames: TerminalByteStreamFrame[];
  rendererAcks: Map<string, number>;
};

function splitByApproxBytesUtf8(input: string, maxBytes: number): string[] {
  const safeMaxBytes = Math.max(1, Math.trunc(maxBytes));
  const out: string[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    let end = Math.min(input.length, cursor + safeMaxBytes);
    while (end > cursor && Buffer.byteLength(input.slice(cursor, end), 'utf8') > safeMaxBytes) {
      end -= 1;
    }
    if (end <= cursor) {
      end = Math.min(input.length, cursor + 1);
    }
    out.push(input.slice(cursor, end));
    cursor = end;
  }
  return out;
}

function resolveTerminalSpawnEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const configuredPromptEolMark = env.HAPPIER_DAEMON_TERMINAL_PROMPT_EOL_MARK;
  return stripCliApiTokenEnvironment({
    ...env,
    PROMPT_EOL_MARK: typeof configuredPromptEolMark === 'string'
      ? configuredPromptEolMark
      : (env.PROMPT_EOL_MARK ?? ''),
  });
}

function isByteCapablePlatform(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

function pushControlFrame(session: PtySession, frame: TerminalByteStreamFrame, config: TerminalPtySessionManagerConfig): void {
  session.controlFrames.push(frame);
  const maxFrames = Math.max(1, Math.trunc(config.bufferMaxEvents));
  while (session.controlFrames.length > maxFrames) {
    session.controlFrames.shift();
  }
}

function pushDecodedText(
  session: PtySession,
  text: string,
  config: TerminalPtySessionManagerConfig,
  streamByteOffset?: number,
): void {
  if (!text) return;
  const chunks = splitByApproxBytesUtf8(text, config.maxWriteChunkBytes);
  for (const chunk of chunks) {
    pushEvent(session.buffer, { t: 'data', data: chunk }, config);
  }
  const urls = session.urlDetector.ingest(text);
  for (const url of urls) {
    pushEvent(session.buffer, { t: 'url', ...url }, config);
    if (streamByteOffset !== undefined) {
      pushControlFrame(session, {
        t: 'url',
        terminalId: session.terminalId,
        byteOffset: streamByteOffset,
        ...url,
      }, config);
    }
  }
}

export function createTerminalPtySessionManager(params: Readonly<{
  ptyProvider: PtyProvider;
  config: TerminalPtySessionManagerConfig;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /**
   * Optional terminal->port registration store. When supplied, the manager registers
   * each spawned pid (with workspace + session + terminal attribution) so the
   * local-services scanner can deterministically scope/attribute the listener, and
   * identity-checked-unregisters on close/exit/reap/evict. Defaults to no-op so unit
   * tests and non-daemon callers stay unaffected.
   */
  terminalRegistry?: TerminalProcessRegistry;
}>): TerminalPtySessionManager {
  const now = params.now ?? (() => Date.now());
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const config = params.config;
  const terminalRegistry = params.terminalRegistry ?? null;
  const metrics = createTerminalPtyMetrics();

  const sessionsById = new Map<string, PtySession>();
  const terminalIdByKey = new Map<string, string>();

  const removeSession = (session: PtySession): void => {
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
    session.byteRing.clear();
    sessionsById.delete(session.terminalId);
    if (terminalIdByKey.get(session.terminalKey) === session.terminalId) {
      terminalIdByKey.delete(session.terminalKey);
    }
    // Identity-checked unregister: covers close, reapIdle, max-session eviction, and
    // restart-teardown from one site. The registry only removes when it still owns
    // this run's terminalId, so a stale older-run teardown cannot drop a newer run.
    terminalRegistry?.unregister({ terminalKey: session.terminalKey, terminalId: session.terminalId });
  };

  const reapIdle = () => {
    const current = now();
    const timeoutMs = Math.max(0, Math.trunc(config.idleTimeoutMs));
    if (!timeoutMs) return;

    for (const session of sessionsById.values()) {
      if (current - session.lastActivityAtMs < timeoutMs) continue;
      removeSession(session);
    }
  };

  const closeById = (terminalId: string): SimpleOk | ErrorResult => {
    reapIdle();
    const session = sessionsById.get(terminalId);
    if (!session) return okDisabled('terminal_not_found');
    removeSession(session);
    return { ok: true };
  };

  const ensure = (input: Readonly<{ terminalKey: string; cwd: string; cols?: number; rows?: number; initialCommand?: string; launchProcess?: TerminalLaunchProcess; sessionId?: string }>): EnsureOk | ErrorResult => {
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
          } catch (error) {
            return okDisabled(isTerminalResizeUnavailableError(error) ? 'terminal_resize_unavailable' : 'terminal_not_found');
          }
        }
        return { ok: true, terminalId: existingId, reused: true };
      }
    }

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
    const byteCapablePlatform = isByteCapablePlatform(platform);

    const shell = resolveTerminalShell(env, platform);
    const process = input.launchProcess ?? { file: shell.file, args: shell.args.slice() };

    let pty: PtyProcess;
    try {
      pty = params.ptyProvider.spawn({
        file: process.file,
        args: [...process.args],
        options: {
          name: 'xterm-256color',
          cols,
          rows,
          cwd: input.cwd,
          env: resolveTerminalSpawnEnv({ ...env, ...process.env }),
          encoding: byteCapablePlatform ? null : 'utf8',
        },
      });
    } catch {
      return okDisabled('terminal_spawn_failed');
    }

    const buffer: EventBuffer = { baseCursor: 0, events: [], bytes: 0 };
    const byteRing = createTerminalByteRing({
      maxBytes: config.bufferMaxBytes,
      maxChunks: config.bufferMaxEvents,
      maxAgeMs: config.bufferRetentionMs,
      now,
    });
    const urlDetector = createTerminalUrlDetector({
      bufferLimit: config.urlParseBufferLimit,
      seenLimit: config.urlDedupeLimit,
    });
    const session: PtySession = {
      terminalId,
      terminalKey: input.terminalKey,
      cwd: input.cwd,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      cols,
      rows,
      pty,
      disposables: [],
      buffer,
      byteRing,
      byteMode: byteCapablePlatform
        ? { kind: 'bytes' }
        : { kind: 'legacyOnly', provider: 'windows-conpty', reason: 'Windows ConPTY raw byte fidelity has not been proven' },
      ended: false,
      exit: null,
      lastActivityAtMs: now(),
      urlDetector,
      decoder: createUtf8StreamDecoder(),
      controlFrames: [],
      rendererAcks: new Map(),
    };
    if (session.byteMode.kind === 'legacyOnly') {
      metrics.recordLegacyOnlyProvider();
    }

    const consumeBytes = (bytes: Buffer) => {
      if (!bytes.length) return;
      session.lastActivityAtMs = now();
      const before = session.byteRing.bounds().chunkCount;
      const written = session.byteRing.write(bytes);
      const after = session.byteRing.bounds().chunkCount;
      if (written) {
        metrics.recordBytesWritten(written.byteLength);
      }
      if (after < before + (written ? 1 : 0)) {
        metrics.recordChunksDropped(before + (written ? 1 : 0) - after);
      }
      const decoded = session.decoder.decode(bytes);
      pushDecodedText(
        session,
        decoded,
        config,
        written ? written.byteOffset + written.byteLength : session.byteRing.bounds().totalBytesWritten,
      );
    };

    const consumeLegacyString = (text: string) => {
      session.lastActivityAtMs = now();
      if (session.byteMode.kind === 'bytes') {
        session.byteMode = { kind: 'legacyOnly', provider: 'unknown', reason: 'PTY provider emitted decoded strings instead of raw bytes' };
        metrics.recordLegacyOnlyProvider();
      }
      pushDecodedText(session, String(text ?? ''), config);
    };

    if (byteCapablePlatform && typeof pty.onDataBytes === 'function') {
      session.disposables.push(pty.onDataBytes((data) => {
        if (Buffer.isBuffer(data)) {
          consumeBytes(Buffer.from(data));
          return;
        }
        consumeLegacyString(String(data ?? ''));
      }));
    } else {
      session.disposables.push(
        pty.onData((data) => {
          if (Buffer.isBuffer(data)) {
            consumeBytes(data);
            return;
          }
          consumeLegacyString(String(data ?? ''));
        }),
      );
    }

    session.disposables.push(
      pty.onExit((e) => {
        session.lastActivityAtMs = now();
        session.ended = true;
        session.exit = { exitCode: e.exitCode ?? null, signal: typeof e.signal === 'number' ? e.signal : null };
        metrics.recordExit();
        pushEvent(session.buffer, { t: 'exit', ...session.exit }, config);
        // Unregister immediately on self-exit: an exited session lingers in
        // sessionsById until the next reap/close and must not keep stamping a dead
        // pid. Identity-checked by this run's terminalId (the closure captured this
        // run's session), so a late exit from an older run cannot drop a newer run
        // that re-claimed the same terminalKey via restart().
        terminalRegistry?.unregister({ terminalKey: session.terminalKey, terminalId: session.terminalId });
      }),
    );

    sessionsById.set(terminalId, session);
    terminalIdByKey.set(input.terminalKey, terminalId);

    // Register on spawn (replace-by-terminalKey). sessionId is attribution metadata,
    // passed through when present. Skip when the backend could not supply a pid
    // (pid 0) — never register a bogus pid.
    if (terminalRegistry && pty.pid) {
      terminalRegistry.registerTerminalProcesses({
        terminalKey: input.terminalKey,
        workspacePath: input.cwd,
        pids: [pty.pid],
        terminalId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
    }

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

  const restart = (input: Readonly<{ terminalKey: string; cwd: string; cols?: number; rows?: number; initialCommand?: string; launchProcess?: TerminalLaunchProcess; sessionId?: string }>): EnsureOk | ErrorResult => {
    reapIdle();
    const existing = terminalIdByKey.get(input.terminalKey) ?? null;
    if (existing) {
      closeById(existing);
    }
    return ensure(input);
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

  const readBytes = (input: Readonly<{ terminalId: string; byteOffset: number; maxBytes: number; maxChunks: number }>): TerminalByteReadResult => {
    reapIdle();
    const session = sessionsById.get(input.terminalId);
    if (!session) return okDisabled('terminal_not_found');
    session.lastActivityAtMs = now();
    if (session.byteMode.kind === 'legacyOnly') {
      return {
        ok: true,
        terminalId: input.terminalId,
        mode: 'legacyOnly',
        provider: session.byteMode.provider,
        reason: session.byteMode.reason,
        done: session.ended,
      };
    }
    const result = session.byteRing.read({
      byteOffset: normalizeByteOffset(input.byteOffset),
      maxBytes: input.maxBytes,
      maxChunks: input.maxChunks,
    });
    if (result.gap) {
      metrics.recordGapRead();
    }
    metrics.recordBytesRead(result.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    return {
      ok: true,
      terminalId: input.terminalId,
      mode: 'bytes',
      chunks: result.chunks,
      nextByteOffset: result.nextByteOffset,
      availableByteOffset: result.availableByteOffset,
      droppedBeforeByteOffset: result.droppedBeforeByteOffset,
      done: session.ended && result.nextByteOffset >= result.totalBytesWritten,
      ...(result.gap ? { gap: result.gap } : {}),
      ...(session.exit && result.nextByteOffset >= result.totalBytesWritten ? { exit: session.exit } : {}),
    };
  };

  const readByteStream = (input: TerminalByteStreamReadRequest): TerminalByteStreamReadResponse => {
    const requestedMaxBytes = Math.max(1, Math.trunc(input.maxBytes ?? config.maxWriteChunkBytes));
    const creditBytes = typeof input.creditBytes === 'number' && Number.isFinite(input.creditBytes)
      ? Math.max(0, Math.trunc(input.creditBytes))
      : requestedMaxBytes;
    const maxBytes = Math.min(requestedMaxBytes, creditBytes);
    const maxFrames = Math.max(1, Math.trunc(input.maxFrames ?? config.bufferMaxEvents));
    if (input.ackedByteOffset !== undefined) {
      const ack = acknowledgeByteStream({
        terminalId: input.terminalId,
        ackedByteOffset: input.ackedByteOffset,
        ...(input.rendererId ? { rendererId: input.rendererId } : {}),
        ...(input.surfaceEpoch !== undefined ? { surfaceEpoch: input.surfaceEpoch } : {}),
        ...(input.creditBytes !== undefined ? { creditBytes: input.creditBytes } : {}),
      });
      if (!ack.ok) return ack;
    }
    if (maxBytes <= 0) {
      reapIdle();
      const session = sessionsById.get(input.terminalId);
      if (!session) return { ok: false, code: 'terminal_not_found', message: 'terminal_not_found' };
      session.lastActivityAtMs = now();
      if (session.byteMode.kind === 'legacyOnly') {
        return {
          ok: true,
          terminalId: input.terminalId,
          frames: [{
            t: 'legacyOnly',
            terminalId: input.terminalId,
            provider: session.byteMode.provider,
            reason: session.byteMode.reason,
          }],
          nextByteOffset: input.byteOffset,
          availableByteOffset: input.byteOffset,
          droppedBeforeByteOffset: input.byteOffset,
          done: session.ended,
        };
      }
      const bounds = session.byteRing.bounds();
      const requested = normalizeByteOffset(input.byteOffset);
      const nextByteOffset = Math.max(Math.min(requested, bounds.totalBytesWritten), bounds.droppedBeforeByteOffset);
      const frames: TerminalByteStreamFrame[] = requested < bounds.droppedBeforeByteOffset
        ? [{
            t: 'gap',
            terminalId: input.terminalId,
            droppedBeforeByteOffset: bounds.droppedBeforeByteOffset,
            nextAvailableByteOffset: bounds.droppedBeforeByteOffset,
            reason: 'ring_overflow',
          }]
        : [];
      session.controlFrames = session.controlFrames.filter((frame) => frame.t !== 'url' || frame.byteOffset >= bounds.droppedBeforeByteOffset);
      const deliveredControlFrames = new Set<TerminalByteStreamFrame>();
      for (const frame of session.controlFrames) {
        if (frames.length >= maxFrames) break;
        if (frame.t !== 'url') continue;
        if (frame.byteOffset < requested || frame.byteOffset > bounds.totalBytesWritten) continue;
        frames.push(frame);
        deliveredControlFrames.add(frame);
      }
      if (deliveredControlFrames.size > 0) {
        session.controlFrames = session.controlFrames.filter((frame) => !deliveredControlFrames.has(frame));
      }
      const deliveredAllBytes = nextByteOffset >= bounds.totalBytesWritten;
      let deliveredExit = false;
      if (session.exit && deliveredAllBytes && frames.length < maxFrames) {
        frames.push({
          t: 'exit',
          terminalId: input.terminalId,
          byteOffset: nextByteOffset,
          exitCode: session.exit.exitCode,
          signal: session.exit.signal,
        });
        deliveredExit = true;
      }
      return {
        ok: true,
        terminalId: input.terminalId,
        frames,
        nextByteOffset,
        availableByteOffset: bounds.totalBytesWritten,
        droppedBeforeByteOffset: bounds.droppedBeforeByteOffset,
        done: session.ended && deliveredAllBytes && (!session.exit || deliveredExit),
      };
    }
    const raw = readBytes({
      terminalId: input.terminalId,
      byteOffset: input.byteOffset,
      maxBytes,
      maxChunks: maxFrames,
    });
    if (!raw.ok) {
      return { ok: false, code: raw.errorCode, message: raw.error };
    }

    if (raw.mode === 'legacyOnly') {
      return {
        ok: true,
        terminalId: raw.terminalId,
        frames: [{
          t: 'legacyOnly',
          terminalId: raw.terminalId,
          provider: raw.provider,
          reason: raw.reason,
        }],
        nextByteOffset: input.byteOffset,
        availableByteOffset: input.byteOffset,
        droppedBeforeByteOffset: input.byteOffset,
        done: raw.done,
      };
    }

    const session = sessionsById.get(raw.terminalId);
    const frames: TerminalByteStreamFrame[] = [];
    let streamNextByteOffset = raw.chunks[0]?.byteOffset ?? raw.nextByteOffset;
    if (raw.gap) {
      frames.push({
        t: 'gap',
        terminalId: raw.terminalId,
        droppedBeforeByteOffset: raw.gap.droppedBeforeByteOffset,
        nextAvailableByteOffset: raw.gap.nextAvailableByteOffset,
          reason: raw.gap.reason,
      });
    }
    chunks:
    for (const chunk of raw.chunks) {
      for (
        let start = 0;
        start < chunk.bytes.length;
        start += TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES
      ) {
        if (frames.length >= maxFrames) break chunks;
        const bytes = chunk.bytes.subarray(
          start,
          Math.min(start + TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES, chunk.bytes.length),
        );
        const byteOffset = chunk.byteOffset + start;
        frames.push({
          t: 'bytes',
          terminalId: raw.terminalId,
          seq: chunk.seq,
          byteOffset,
          byteLength: bytes.length,
          encoding: 'base64',
          data: bytes.toString('base64'),
        });
        streamNextByteOffset = byteOffset + bytes.length;
      }
    }
    if (session) {
      const droppedBefore = raw.droppedBeforeByteOffset;
      session.controlFrames = session.controlFrames.filter((frame) => frame.t !== 'url' || frame.byteOffset >= droppedBefore);
      const deliveredControlFrames = new Set<TerminalByteStreamFrame>();
      for (const frame of session.controlFrames) {
        if (frames.length >= maxFrames) break;
        if (frame.t !== 'url') continue;
        if (frame.byteOffset < input.byteOffset || frame.byteOffset > streamNextByteOffset) continue;
        frames.push(frame);
        deliveredControlFrames.add(frame);
      }
      if (deliveredControlFrames.size > 0) {
        session.controlFrames = session.controlFrames.filter((frame) => !deliveredControlFrames.has(frame));
      }
    }
    const deliveredAllReadBytes = streamNextByteOffset >= raw.nextByteOffset;
    let deliveredExit = false;
    if (raw.exit && deliveredAllReadBytes && frames.length < maxFrames) {
      frames.push({
        t: 'exit',
        terminalId: raw.terminalId,
        byteOffset: streamNextByteOffset,
        exitCode: raw.exit.exitCode,
        signal: raw.exit.signal,
      });
      deliveredExit = true;
    }

    return {
      ok: true,
      terminalId: raw.terminalId,
      frames,
      nextByteOffset: streamNextByteOffset,
      availableByteOffset: raw.availableByteOffset,
      droppedBeforeByteOffset: raw.droppedBeforeByteOffset,
      done: raw.done && deliveredAllReadBytes && (!raw.exit || deliveredExit),
    };
  };

  const acknowledgeByteStream = (input: TerminalByteStreamAckRequest): TerminalByteStreamAckResponse => {
    reapIdle();
    const session = sessionsById.get(input.terminalId);
    if (!session) {
      return { ok: false, code: 'terminal_not_found', message: 'terminal_not_found' };
    }
    const rendererId = input.rendererId ?? 'default';
    const surfaceEpoch = input.surfaceEpoch ?? 0;
    const key = `${rendererId}:${surfaceEpoch}`;
    const previous = session.rendererAcks.get(key) ?? 0;
    const next = Math.max(previous, normalizeByteOffset(input.ackedByteOffset));
    if (next !== previous) {
      session.rendererAcks.set(key, next);
      metrics.recordRendererAck({
        ackedByteOffset: next,
        availableByteOffset: session.byteRing.bounds().totalBytesWritten,
      });
    }
    return { ok: true };
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

  const inputEvent = (input: TerminalStreamInputRequest): TerminalStreamInputResponse => {
    const action = terminalInputEventToPtyAction(input.event);
    if (action.kind === 'unsupported') {
      return { ok: false, code: action.code, message: action.message };
    }
    if (action.kind === 'noop') {
      return { ok: true };
    }
    if (action.kind === 'resize') {
      const result = resize({ terminalId: input.terminalId, cols: action.cols, rows: action.rows });
      return result.ok
        ? { ok: true }
        : { ok: false, code: result.errorCode, message: result.error };
    }
    const result = inputData({ terminalId: input.terminalId, data: action.data });
    return result.ok
      ? { ok: true }
      : { ok: false, code: result.errorCode, message: result.error };
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
    } catch (error) {
      if (isTerminalResizeUnavailableError(error)) {
        return okDisabled('terminal_resize_unavailable');
      }
      return okDisabled('terminal_not_found');
    }
  };

  const close = (input: Readonly<{ terminalId: string }>): SimpleOk | ErrorResult => closeById(input.terminalId);

  return {
    ensure,
    restart,
    read,
    readBytes,
    readByteStream,
    acknowledgeByteStream,
    inputEvent,
    input: inputData,
    resize,
    close,
    metrics: () => metrics.snapshot(),
  };
}
