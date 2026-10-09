import { Buffer } from 'node:buffer';
import { stripCliApiTokenEnvironment } from '@/auth/cliApiToken';
import { randomUUID } from 'node:crypto';
import { probeProcessGroupLiveness } from '@happier-dev/cli-common/process';

import { TERMINAL_STREAM_MAX_FRAME_DECODED_BYTES, TERMINAL_STREAM_MAX_FRAMES } from '@happier-dev/protocol/terminal/stream';
import { terminalInputEventToPtyAction } from '@happier-dev/protocol/terminal/inputEncoding';
import type {
  DaemonTerminalErrorCode,
  DaemonTerminalListEntryV1,
  DaemonTerminalStreamEvent,
  TerminalStreamFrame,
  TerminalStreamReadRequest,
  TerminalStreamReadResponse,
  TerminalStreamInputRequest,
  TerminalStreamInputResponse,
} from '@happier-dev/protocol';

import type { TerminalProcessRegistry } from '@/daemon/local/services/inventory/terminalRegistry';
import type { LiveWorkItemV1, LiveWorkProducerV1 } from '@/daemon/lifecycle/managedActivity';
import type { DaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';
import { killProcessTree } from '@/agent/runtime/process/killProcessTree';
import {
  queryProcessCustodyJob,
  terminateProcessCustodyByJob,
  type ProcessCustodyExecFile,
} from '@/subprocess/supervision/processCustody';

import { createTerminalByteRing, type TerminalByteRing, type TerminalByteRingChunk } from './byteRing';
import { normalizeByteOffset, normalizeLegacyCursor } from './cursors';
import { createUtf8StreamDecoder } from './decode';
import { createTerminalPtyMetrics, type TerminalPtyMetrics } from './metrics';
import type { Disposable, PtyProvider, PtyProcess } from './provider';
import type { TerminalLaunchProcess } from './launch';
import type { HostAuthorizedPluginExecLaunch } from '@/plugins/runtime/invocation/services/exec';
import { resolveTerminalShell } from './shells';
import { createTerminalUrlDetector, type DetectedTerminalUrl } from './urlDetection';

type ErrorResult = Readonly<{
  ok: false;
  errorCode: DaemonTerminalErrorCode;
  error: string;
}>;

type EnsureOk = Readonly<{ ok: true; terminalId: string; reused: boolean }>;
type ReadOk = Readonly<{ ok: true; terminalId: string; events: readonly DaemonTerminalStreamEvent[]; nextCursor: number; done: boolean }>;
type SimpleOk = Readonly<{ ok: true }>;

export type TerminalProcessExitObservation =
  | Readonly<{ kind: 'exited'; exit: Readonly<{ exitCode: number | null; signal: number | null }> }>
  | Readonly<{ kind: 'unavailable' }>;

export type TerminalProcessStopObservation = Readonly<{ kind: 'requested' | 'unconfirmed' | 'exited' | 'unavailable' }>;
type TerminalProcessExitEvent = TerminalProcessExitObservation | Readonly<{ kind: 'outcome_uncertain' }>;

/** Host-private accepted attribution. This is never parsed from a terminal request. */
type TerminalPtyCustodyBase = Readonly<{
  serverId: string;
  requesterAccountId: string;
  machineId: string;
  installationId: string;
  rootPath: string;
}>;

export type TerminalPtyProjectCustody = TerminalPtyCustodyBase & Readonly<{
  kind?: undefined;
  sessionId?: never;
  workspaceRefId: string;
  projectKey: string;
}>;
export type TerminalPtySessionCustody = TerminalPtyCustodyBase & Readonly<{
  kind: 'session'; sessionId: string; workspaceRefId?: never; projectKey?: never;
}>;
export type TerminalPtyMachineCustody = TerminalPtyCustodyBase & Readonly<{
  kind: 'machine'; sessionId?: never; workspaceRefId?: never; projectKey?: never;
}>;
export type TerminalPtyCustody = TerminalPtyProjectCustody | TerminalPtySessionCustody | TerminalPtyMachineCustody;

export type TerminalPtyEnsureInput = Readonly<{
  terminalKey: string;
  cwd: string;
  cols?: number;
  rows?: number;
  initialCommand?: string;
  launchProcess?: TerminalLaunchProcess;
  /** Actual B4 final tuple, supplied only by the host Project preparation owner. */
  authorizedProjectLaunch?: HostAuthorizedPluginExecLaunch;
  sessionId?: string;
  /** Authenticated custody; supplied by the admitting owner, never a terminal request body. */
  requesterAccountId?: string;
  custody?: TerminalPtyCustody;
  /** Finite direct processes retain custody until observed process settlement. */
  holdUntilExit?: true;
  /** Raw Machine starts supply the canonical drain; accepted finite work has its own admission owner. */
  admissionDrain?: DaemonAdmissionDrain;
}>;

function terminalStorageKey(input: TerminalPtyEnsureInput): string {
  const custody = input.custody;
  return custody ? JSON.stringify([custody.kind ?? 'project', custody.serverId, custody.requesterAccountId, custody.machineId, custody.installationId,
    custody.kind === 'session' ? ['session', custody.sessionId] : custody.kind === 'machine' ? ['machine'] : [custody.workspaceRefId, custody.projectKey],
    custody.rootPath, input.sessionId ?? null, input.terminalKey])
    : input.sessionId ? JSON.stringify(['session', input.sessionId, input.terminalKey]) : input.terminalKey;
}

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

export type TerminalByteStreamReadRequest = TerminalStreamReadRequest;

export type TerminalByteStreamFrame = TerminalStreamFrame;

export type TerminalByteStreamReadResponse = TerminalStreamReadResponse;

export type TerminalByteStreamAckRequest = Readonly<{
  terminalId: string;
  ackedByteOffset: number;
  rendererId?: string;
  surfaceEpoch?: number;
  creditBytes?: number;
}>;

export type TerminalByteStreamAckResponse = Readonly<{ ok: true }> | Readonly<{ ok: false; code: string; message: string }>;

export type TerminalPtySessionManager = Readonly<{
  list: () => DaemonTerminalListEntryV1[];
  getLiveWorkProducer: () => LiveWorkProducerV1;
  getCustody: (terminalId: string) => TerminalPtyCustody | null;
  isFiniteHeld: (terminalId: string) => boolean;
  ensure: (input: TerminalPtyEnsureInput) => EnsureOk | ErrorResult;
  waitForExit: (input: Readonly<{ terminalId: string; signal?: AbortSignal; onOutcomeUncertain?: () => void }>) => Promise<TerminalProcessExitObservation>;
  requestStop: (input: Readonly<{ terminalId: string }>) => Promise<TerminalProcessStopObservation>;
  read: (input: Readonly<{ terminalId: string; cursor: number; maxBytes: number; maxEvents: number }>) => ReadOk | ErrorResult;
  readBytes: (input: Readonly<{ terminalId: string; byteOffset: number; maxBytes: number; maxChunks: number }>) => TerminalByteReadResult;
  readByteStream: (input: TerminalByteStreamReadRequest) => TerminalByteStreamReadResponse;
  acknowledgeByteStream: (input: TerminalByteStreamAckRequest) => TerminalByteStreamAckResponse;
  inputEvent: (input: TerminalStreamInputRequest) => TerminalStreamInputResponse;
  input: (input: Readonly<{ terminalId: string; data: string }>) => SimpleOk | ErrorResult;
  resize: (input: Readonly<{ terminalId: string; cols: number; rows: number }>) => SimpleOk | ErrorResult;
  close: (input: Readonly<{ terminalId: string }>) => SimpleOk | ErrorResult;
  dispose: () => void;
  restart: (input: TerminalPtyEnsureInput) => EnsureOk | ErrorResult;
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

type SequencedTerminalControlFrame = Readonly<{
  seq: number;
  frame: Extract<TerminalByteStreamFrame, { t: 'url' }>;
}>;

type PtySession = {
  terminalId: string;
  terminalKey: string;
  storageKey: string;
  cwd: string;
  sessionId?: string;
  requesterAccountId?: string;
  custody?: TerminalPtyCustody;
  finiteHold: boolean;
  stopPending: boolean;
  stopUnconfirmed: boolean;
  exitObservers: Set<(observation: TerminalProcessExitEvent) => void>;
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
  controlFrames: SequencedTerminalControlFrame[];
  nextControlFrameSeq: number;
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

function pushControlFrame(
  session: PtySession,
  frame: Extract<TerminalByteStreamFrame, { t: 'url' }>,
  config: TerminalPtySessionManagerConfig,
): void {
  session.controlFrames.push({ seq: session.nextControlFrameSeq, frame });
  session.nextControlFrameSeq += 1;
  const maxFrames = Math.max(1, Math.trunc(config.bufferMaxEvents));
  while (session.controlFrames.length > maxFrames) {
    session.controlFrames.shift();
  }
}

function pushDetectedUrls(
  session: PtySession,
  urls: readonly DetectedTerminalUrl[],
  config: TerminalPtySessionManagerConfig,
  streamByteOffset?: number,
): void {
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
  pushDetectedUrls(session, session.urlDetector.ingest(text), config, streamByteOffset);
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
  /** OS process-tree boundary; the default is the existing cross-platform process owner. */
  stopProcessTree?: typeof killProcessTree;
  /** Genuine OS group observation boundary, shared with the process-tree owner. */
  probeProcessGroup?: typeof probeProcessGroupLiveness;
  /** Genuine native-helper execution boundary; custody policy stays at its existing owner. */
  processCustodyExecFile?: ProcessCustodyExecFile;
}>): TerminalPtySessionManager {
  const now = params.now ?? (() => Date.now());
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const config = params.config;
  const idleTimeoutMs = Math.max(0, Math.trunc(config.idleTimeoutMs));
  const maxRendererAckIdentities = Number.isFinite(config.bufferMaxEvents)
    ? Math.max(1, Math.trunc(config.bufferMaxEvents))
    : 1;
  const terminalRegistry = params.terminalRegistry ?? null;
  const metrics = createTerminalPtyMetrics();
  const stopProcessTree = params.stopProcessTree ?? killProcessTree;
  const probeProcessGroup = params.probeProcessGroup ?? probeProcessGroupLiveness;

  const sessionsById = new Map<string, PtySession>();
  const terminalIdByKey = new Map<string, string>();
  const liveWorkListeners = new Set<() => void>();
  let disposed = false;
  const notifyLiveWorkChanged = () => {
    for (const listener of liveWorkListeners) {
      try { listener(); } catch { /* Observation cannot alter retained PTY custody. */ }
    }
  };
  const getLiveWorkProducer = (): LiveWorkProducerV1 => ({
    read: () => ({
      coverage: disposed ? 'unknown' : 'complete',
      items: Array.from(sessionsById.values(), (session): LiveWorkItemV1 => ({
        category: 'terminal',
        ownerRef: session.terminalId,
        attribution: session.custody ? {
          serverId: session.custody.serverId, accountId: session.custody.requesterAccountId,
          machineId: session.custody.machineId, installationId: session.custody.installationId,
        } : { kind: 'unknown' },
        state: session.stopUnconfirmed ? 'unknown' : session.stopPending || session.finiteHold || !session.ended ? 'active' : 'settled',
      })),
    }),
    subscribe: listener => {
      liveWorkListeners.add(listener);
      return () => { liveWorkListeners.delete(listener); };
    },
  });

  const removeSession = (session: PtySession): void => {
    for (const observer of session.exitObservers) observer({ kind: 'unavailable' });
    session.exitObservers.clear();
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
    if (terminalIdByKey.get(session.storageKey) === session.terminalId) {
      terminalIdByKey.delete(session.storageKey);
    }
    // Identity-checked unregister: covers close, reapIdle, max-session eviction, and
    // restart-teardown from one site. The registry only removes when it still owns
    // this run's terminalId, so a stale older-run teardown cannot drop a newer run.
    terminalRegistry?.unregister({ terminalKey: session.storageKey, terminalId: session.terminalId });
    notifyLiveWorkChanged();
  };

  const belongsToRequester = (session: PtySession, requester: Readonly<{ accountId: string | undefined; custody?: TerminalPtyCustody }>): boolean =>
    session.requesterAccountId === requester.accountId && (!requester.custody || !!session.custody
      && session.custody.serverId === requester.custody.serverId && session.custody.machineId === requester.custody.machineId
      && session.custody.installationId === requester.custody.installationId);

  const reapIdle = (requester?: Readonly<{ accountId: string | undefined; custody?: TerminalPtyCustody }>) => {
    const current = now();
    if (!idleTimeoutMs) return;

    for (const session of sessionsById.values()) {
      if (session.finiteHold || session.stopPending || session.stopUnconfirmed) continue;
      if (requester && !belongsToRequester(session, requester)) continue;
      if (current - session.lastActivityAtMs < idleTimeoutMs) continue;
      removeSession(session);
    }
  };

  const idleReapTimer = idleTimeoutMs > 0
    ? setInterval(reapIdle, idleTimeoutMs)
    : null;
  idleReapTimer?.unref?.();

  const reapTerminalCohort = (terminalId: string): void => {
    const session = sessionsById.get(terminalId);
    if (session) reapIdle({ accountId: session.requesterAccountId, custody: session.custody });
  };

  const closeById = (terminalId: string): SimpleOk | ErrorResult => {
    reapTerminalCohort(terminalId);
    const session = sessionsById.get(terminalId);
    if (!session) return okDisabled('terminal_not_found');
    removeSession(session);
    return { ok: true };
  };

  const ensure = (input: TerminalPtyEnsureInput): EnsureOk | ErrorResult => {
    const requesterAccountId = input.custody?.requesterAccountId ?? input.requesterAccountId;
    // Interactive Project terminals start at the accepted root. Finite host
    // admission supplies the already-reviewed final cwd, which may be a script
    // subdirectory; its accepted root remains custody, not another cwd resolver.
    if (input.custody && ((!input.holdUntilExit && input.cwd !== input.custody.rootPath)
      || input.requesterAccountId !== undefined && input.requesterAccountId !== requesterAccountId)) return okDisabled('terminal_forbidden');
    if (input.custody?.kind === 'session' && input.sessionId !== input.custody.sessionId) return okDisabled('terminal_forbidden');
    const storageKey = terminalStorageKey(input);
    if (input.holdUntilExit && (!input.launchProcess || input.initialCommand || input.launchProcess.initialInput)) {
      return okDisabled('terminal_invalid_request');
    }
    reapIdle({ accountId: requesterAccountId, custody: input.custody });
    if (input.custody?.kind === 'session' && !terminalIdByKey.has(storageKey)) {
      // Fresh exact Session authority can adopt its retained association.
      // Standalone legacy records have no resource witness and are never inferred.
      const legacyId = terminalIdByKey.get(terminalStorageKey({ ...input, custody: undefined, requesterAccountId: undefined }));
      const legacy = legacyId ? sessionsById.get(legacyId) : undefined;
      if (legacy && !legacy.custody && legacy.sessionId === input.custody.sessionId && legacy.cwd === input.cwd
        && !legacy.finiteHold && !legacy.stopPending && !legacy.stopUnconfirmed) {
        terminalRegistry?.unregister({ terminalKey: legacy.storageKey, terminalId: legacy.terminalId });
        terminalIdByKey.delete(legacy.storageKey);
        legacy.storageKey = storageKey;
        legacy.requesterAccountId = requesterAccountId;
        legacy.custody = Object.freeze({ ...input.custody });
        terminalIdByKey.set(storageKey, legacy.terminalId);
        if (terminalRegistry && legacy.pty.pid && !legacy.ended) terminalRegistry.registerTerminalProcesses({
          terminalKey: storageKey, workspacePath: legacy.cwd, pids: [legacy.pty.pid], terminalId: legacy.terminalId,
          sessionId: legacy.sessionId,
        });
        notifyLiveWorkChanged();
      }
    }
    const existingId = terminalIdByKey.get(storageKey) ?? null;
    if (existingId) {
      const existing = sessionsById.get(existingId);
      if (existing && existing.requesterAccountId !== requesterAccountId) return okDisabled('terminal_not_found');
      if (existing?.ended && (existing.finiteHold || existing.stopPending || existing.stopUnconfirmed)) return okDisabled('terminal_busy');
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

    if (input.admissionDrain?.isQuiescing()) return okDisabled('terminal_busy');

    const maxSessions = Math.max(1, Math.trunc(config.maxSessions));
    if (sessionsById.size >= maxSessions) {
      let oldest: PtySession | null = null;
      for (const session of sessionsById.values()) {
        if (session.finiteHold || session.stopPending || session.stopUnconfirmed) continue;
        if (!belongsToRequester(session, { accountId: requesterAccountId, custody: input.custody })) continue;
        if (!oldest || session.lastActivityAtMs < oldest.lastActivityAtMs) {
          oldest = session;
        }
      }
      if (!oldest) return okDisabled('terminal_busy');
      removeSession(oldest);
    }

    const terminalId = randomUUID();
    const cols = typeof input.cols === 'number' && Number.isFinite(input.cols) ? Math.max(2, Math.trunc(input.cols)) : config.defaultCols;
    const rows = typeof input.rows === 'number' && Number.isFinite(input.rows) ? Math.max(2, Math.trunc(input.rows)) : config.defaultRows;
    const byteCapablePlatform = isByteCapablePlatform(platform);

    const shell = resolveTerminalShell(env, platform);
    const authorizedProjectLaunch = input.authorizedProjectLaunch;
    const process: TerminalLaunchProcess = authorizedProjectLaunch
      ? { ...input.launchProcess, file: authorizedProjectLaunch.command, args: authorizedProjectLaunch.args,
        env: authorizedProjectLaunch.env, windowsVerbatimArguments: authorizedProjectLaunch.windowsVerbatimArguments }
      : input.launchProcess ?? { file: shell.file, args: shell.args.slice() };
    const cwd = authorizedProjectLaunch?.cwd ?? input.cwd;

    let pty: PtyProcess;
    try {
      // Removing a prior terminal publishes an owner edge; recheck the same
      // admission decision at the actual native effect boundary.
      if (input.admissionDrain?.isQuiescing()) return okDisabled('terminal_busy');
      pty = params.ptyProvider.spawn({
        file: process.file,
        args: platform === 'win32' && process.windowsVerbatimArguments
          ? process.args.join(' ')
          : [...process.args],
        options: {
          name: 'xterm-256color',
          cols,
          rows,
          cwd,
          // Finalized Project launches preserve native unsets without acquiring a
          // finite hold. Ordinary shell/login launch overlays remain unchanged.
          env: input.holdUntilExit
            ? stripCliApiTokenEnvironment(process.env ?? env)
            : resolveTerminalSpawnEnv(authorizedProjectLaunch ? authorizedProjectLaunch.env : { ...env, ...process.env }),
          encoding: byteCapablePlatform ? null : 'utf8',
        },
        ...(input.holdUntilExit ? { finiteProcess: true } : {}),
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
      storageKey,
      cwd,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(requesterAccountId ? { requesterAccountId } : {}),
      ...(input.custody ? { custody: Object.freeze({ ...input.custody }) } : {}),
      finiteHold: input.holdUntilExit === true,
      stopPending: false,
      stopUnconfirmed: false,
      exitObservers: new Set(),
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
      nextControlFrameSeq: 0,
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
        const finalByteOffset = session.byteRing.bounds().totalBytesWritten;
        pushDecodedText(session, session.decoder.flush(), config, finalByteOffset);
        pushDetectedUrls(session, session.urlDetector.flush(), config, finalByteOffset);
        session.ended = true;
        session.exit = { exitCode: e.exitCode ?? null, signal: typeof e.signal === 'number' ? e.signal : null };
        if (!session.stopPending && !session.stopUnconfirmed) {
          const windowsCustody = session.pty.windowsJobCustody;
          const groupId = session.pty.ownedProcessGroupId;
          const ownedGroup = typeof groupId === 'number' && Number.isInteger(groupId)
            && groupId > 1 && groupId <= 2_147_483_647;
          if (session.finiteHold && windowsCustody) {
            // Native PTY exit can precede our private establishment read (or
            // be a transport error). Neither event proves the exact Job empty.
            session.stopUnconfirmed = true;
            void (async () => {
              const established = await windowsCustody.established;
              const state = established ? await queryProcessCustodyJob({
                ...windowsCustody, execFile: params.processCustodyExecFile,
              }) : 'unavailable';
              if (sessionsById.get(session.terminalId) !== session) return;
              if (state === 'absent' && !session.stopPending && session.exit) {
                session.stopUnconfirmed = false;
                session.finiteHold = false;
                for (const observer of session.exitObservers) observer({ kind: 'exited', exit: session.exit });
                session.exitObservers.clear();
              } else if (state !== 'absent') {
                for (const observer of session.exitObservers) observer({ kind: 'outcome_uncertain' });
              }
              notifyLiveWorkChanged();
            })().catch(() => {
              if (sessionsById.get(session.terminalId) !== session) return;
              for (const observer of session.exitObservers) observer({ kind: 'outcome_uncertain' });
              notifyLiveWorkChanged();
            });
          } else if (session.finiteHold && (!ownedGroup || probeProcessGroup(groupId) !== 'absent')) {
            session.stopUnconfirmed = true;
            for (const observer of session.exitObservers) observer({ kind: 'outcome_uncertain' });
          } else {
            session.finiteHold = false;
            for (const observer of session.exitObservers) observer({ kind: 'exited', exit: session.exit });
            session.exitObservers.clear();
          }
        }
        metrics.recordExit();
        pushEvent(session.buffer, { t: 'exit', ...session.exit }, config);
        // Unregister immediately on self-exit: an exited session lingers in
        // sessionsById until the next reap/close and must not keep stamping a dead
        // pid. Identity-checked by this run's terminalId (the closure captured this
        // run's session), so a late exit from an older run cannot drop a newer run
        // that re-claimed the same terminalKey via restart().
        terminalRegistry?.unregister({ terminalKey: session.storageKey, terminalId: session.terminalId });
        if (sessionsById.get(session.terminalId) === session) notifyLiveWorkChanged();
      }),
    );

    sessionsById.set(terminalId, session);
    terminalIdByKey.set(storageKey, terminalId);
    notifyLiveWorkChanged();

    // Register on spawn (replace-by-terminalKey). sessionId is attribution metadata,
    // passed through when present. Skip when the backend could not supply a pid
    // (pid 0) — never register a bogus pid.
    if (terminalRegistry && pty.pid) {
      terminalRegistry.registerTerminalProcesses({
        terminalKey: storageKey,
        workspacePath: input.cwd,
        pids: [pty.pid],
        terminalId,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      });
    }

    if (input.launchProcess?.initialInput) {
      try {
        pty.write(input.launchProcess.initialInput);
      } catch {
        closeById(terminalId);
        return okDisabled('terminal_spawn_failed');
      }
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

  const restart = (input: TerminalPtyEnsureInput): EnsureOk | ErrorResult => {
    if (input.admissionDrain?.isQuiescing()) return okDisabled('terminal_busy');
    reapIdle({ accountId: input.custody?.requesterAccountId ?? input.requesterAccountId, custody: input.custody });
    // Retain the predecessor's own unqualified restart only for one unambiguous
    // legacy record. It cannot select a Project/requester-attributed terminal.
    const legacy = !input.custody && !input.sessionId
      ? [...sessionsById.values()].filter(session => !session.custody && session.terminalKey === input.terminalKey
        && session.requesterAccountId === input.requesterAccountId) : [];
    if (legacy.length > 1) return okDisabled('terminal_not_found');
    const existing = terminalIdByKey.get(terminalStorageKey(input)) ?? legacy[0]?.terminalId ?? null;
    const previous = existing ? sessionsById.get(existing) : undefined;
    if (previous && previous.requesterAccountId !== (input.custody?.requesterAccountId ?? input.requesterAccountId)) return okDisabled('terminal_not_found');
    if (previous?.finiteHold || previous?.stopPending || previous?.stopUnconfirmed) return okDisabled('terminal_busy');
    const sessionId = input.sessionId ?? (existing ? sessionsById.get(existing)?.sessionId : undefined);
    if (existing) {
      closeById(existing);
    }
    return ensure({ ...input, ...(sessionId ? { sessionId } : {}) });
  };

  const read = (input: Readonly<{ terminalId: string; cursor: number; maxBytes: number; maxEvents: number }>): ReadOk | ErrorResult => {
    reapTerminalCohort(input.terminalId);
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
    reapTerminalCohort(input.terminalId);
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
    const maxFrames = Math.min(
      TERMINAL_STREAM_MAX_FRAMES,
      Math.max(1, Math.trunc(input.maxFrames ?? config.bufferMaxEvents)),
    );
    const controlCursorRequested = input.controlCursor !== undefined;
    const controlCursor = normalizeByteOffset(input.controlCursor ?? 0);
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
      reapTerminalCohort(input.terminalId);
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
      session.controlFrames = session.controlFrames.filter(({ frame }) => frame.byteOffset >= bounds.droppedBeforeByteOffset);
      let nextControlCursor = controlCursor;
      for (const entry of session.controlFrames) {
        if (frames.length >= maxFrames) break;
        if (entry.seq < controlCursor) continue;
        const frame = entry.frame;
        if (frame.byteOffset < requested || frame.byteOffset > bounds.totalBytesWritten) continue;
        frames.push(frame);
        nextControlCursor = entry.seq + 1;
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
        ...(controlCursorRequested ? { nextControlCursor } : {}),
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
    let nextControlCursor = controlCursor;
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
      session.controlFrames = session.controlFrames.filter(({ frame }) => frame.byteOffset >= droppedBefore);
      for (const entry of session.controlFrames) {
        if (frames.length >= maxFrames) break;
        if (entry.seq < controlCursor) continue;
        const frame = entry.frame;
        if (frame.byteOffset < input.byteOffset || frame.byteOffset > streamNextByteOffset) continue;
        frames.push(frame);
        nextControlCursor = entry.seq + 1;
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
      ...(controlCursorRequested ? { nextControlCursor } : {}),
      done: raw.done && deliveredAllReadBytes && (!raw.exit || deliveredExit),
    };
  };

  const acknowledgeByteStream = (input: TerminalByteStreamAckRequest): TerminalByteStreamAckResponse => {
    reapTerminalCohort(input.terminalId);
    const session = sessionsById.get(input.terminalId);
    if (!session) {
      return { ok: false, code: 'terminal_not_found', message: 'terminal_not_found' };
    }
    const rendererId = input.rendererId ?? 'default';
    const surfaceEpoch = input.surfaceEpoch ?? 0;
    const key = `${rendererId}:${surfaceEpoch}`;
    // ACK identities are retained only for content-free diagnostics. Their LRU
    // bound cannot affect the request-owned byte offset or renderer credit.
    const previous = session.rendererAcks.get(key) ?? 0;
    const next = Math.max(previous, normalizeByteOffset(input.ackedByteOffset));
    if (next !== previous) {
      session.rendererAcks.delete(key);
      session.rendererAcks.set(key, next);
      while (session.rendererAcks.size > maxRendererAckIdentities) {
        const oldest = session.rendererAcks.keys().next().value;
        if (oldest === undefined) break;
        session.rendererAcks.delete(oldest);
      }
      metrics.recordRendererAck({
        ackedByteOffset: next,
        availableByteOffset: session.byteRing.bounds().totalBytesWritten,
      });
    } else if (session.rendererAcks.has(key)) {
      // This is diagnostic-only retention. Keep recently active identities while
      // request byte offsets and credit remain the authoritative stream state.
      session.rendererAcks.delete(key);
      session.rendererAcks.set(key, previous);
    }
    return { ok: true };
  };

  const inputData = (input: Readonly<{ terminalId: string; data: string }>): SimpleOk | ErrorResult => {
    reapTerminalCohort(input.terminalId);
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
    reapTerminalCohort(input.terminalId);
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

  const waitForExit = (input: Readonly<{ terminalId: string; signal?: AbortSignal; onOutcomeUncertain?: () => void }>): Promise<TerminalProcessExitObservation> => {
    const session = sessionsById.get(input.terminalId);
    if (!session || input.signal?.aborted) return Promise.resolve({ kind: 'unavailable' });
    if (session.exit && !session.stopPending && !session.stopUnconfirmed) {
      return Promise.resolve({ kind: 'exited', exit: session.exit });
    }
    return new Promise((resolve) => {
      const finish = (observation: TerminalProcessExitEvent) => {
        if (observation.kind === 'outcome_uncertain') {
          try { input.onOutcomeUncertain?.(); } catch { /* Observation cannot retire process custody. */ }
          return;
        }
        session.exitObservers.delete(finish);
        input.signal?.removeEventListener('abort', abort);
        resolve(observation);
      };
      const abort = () => finish({ kind: 'unavailable' });
      session.exitObservers.add(finish);
      input.signal?.addEventListener('abort', abort, { once: true });
      if (session.exit && session.stopUnconfirmed) finish({ kind: 'outcome_uncertain' });
    });
  };

  const requestStop = async (input: Readonly<{ terminalId: string }>): Promise<TerminalProcessStopObservation> => {
    const session = sessionsById.get(input.terminalId);
    if (!session) return { kind: 'unavailable' };
    if (session.exit && !session.stopPending && !session.stopUnconfirmed) return { kind: 'exited' };
    if (session.stopPending) return { kind: 'requested' };
    const windowsCustody = session.pty.windowsJobCustody;
    if (windowsCustody) {
      session.stopPending = true;
      notifyLiveWorkChanged();
      try {
        const established = await windowsCustody.established;
        const outcome = await terminateProcessCustodyByJob({ ...windowsCustody, execFile: params.processCustodyExecFile });
        // An absent not-yet-established Job cannot rule out a late helper
        // launch. Missing establishment retains uncertainty even after cleanup.
        if (!established || outcome !== 'absent') {
          session.stopUnconfirmed = true;
          return { kind: 'unconfirmed' };
        }
        session.stopUnconfirmed = false;
        if (session.exit) {
          session.finiteHold = false;
          for (const observer of session.exitObservers) observer({ kind: 'exited', exit: session.exit });
          session.exitObservers.clear();
          return { kind: 'exited' };
        }
        return { kind: 'requested' };
      } catch {
        session.stopUnconfirmed = true;
        return { kind: 'unconfirmed' };
      } finally {
        session.stopPending = false;
        notifyLiveWorkChanged();
      }
    }
    const groupId = session.pty.ownedProcessGroupId;
    const ownedGroup = typeof groupId === 'number' && Number.isInteger(groupId)
      && groupId > 1 && groupId <= 2_147_483_647;
    // A missing root cannot locate reparented descendants. Retry only through
    // a positively owned group, never by guessing from the carrier PID.
    if (session.stopUnconfirmed && session.exit && !ownedGroup) return { kind: 'unconfirmed' };
    if (session.exit && ownedGroup && probeProcessGroup(groupId) === 'absent') {
      // Explicit recovery can prove that the captured group has now settled.
      // Do not signal a terminal root's numeric PID after group disappearance.
      session.stopUnconfirmed = false;
      session.finiteHold = false;
      for (const observer of session.exitObservers) observer({ kind: 'exited', exit: session.exit });
      session.exitObservers.clear();
      notifyLiveWorkChanged();
      return { kind: 'exited' };
    }
    if (!session.pty.pid) {
      session.stopUnconfirmed = true;
      notifyLiveWorkChanged();
      return { kind: 'unconfirmed' };
    }
    session.stopPending = true;
    notifyLiveWorkChanged();
    try {
      if (ownedGroup) {
        await stopProcessTree({ pid: groupId, ...(session.exit ? { exitCode: session.exit.exitCode } : {}) },
          { ownedProcessGroup: true });
      } else {
        await stopProcessTree({ pid: session.pty.pid });
      }
      session.stopUnconfirmed = false;
      if (session.exit) {
        session.finiteHold = false;
        for (const observer of session.exitObservers) observer({ kind: 'exited', exit: session.exit });
        session.exitObservers.clear();
        return { kind: 'exited' };
      }
      return { kind: 'requested' };
    } catch {
      session.stopUnconfirmed = true;
      return { kind: 'unconfirmed' };
    } finally {
      session.stopPending = false;
      notifyLiveWorkChanged();
    }
  };

  const dispose = (): void => {
    disposed = true;
    if (idleReapTimer) clearInterval(idleReapTimer);
    for (const session of [...sessionsById.values()]) {
      removeSession(session);
    }
    notifyLiveWorkChanged();
    liveWorkListeners.clear();
  };

  return {
    getLiveWorkProducer,
    // A read-only projection: listing neither reaps nor renews a terminal's activity.
    list: () => Array.from(sessionsById.values(), (session) => ({
      terminalId: session.terminalId,
      terminalKey: session.terminalKey,
      cwd: session.cwd,
      ...(session.sessionId ? { sessionId: session.sessionId } : {}),
      ended: session.ended,
      exit: session.exit ? { ...session.exit } : null,
    })),
    ensure,
    getCustody: (terminalId) => sessionsById.get(terminalId)?.custody ?? null,
    isFiniteHeld: (terminalId) => sessionsById.get(terminalId)?.finiteHold === true,
    waitForExit,
    requestStop,
    restart,
    read,
    readBytes,
    readByteStream,
    acknowledgeByteStream,
    inputEvent,
    input: inputData,
    resize,
    close,
    dispose,
    metrics: () => metrics.snapshot(sessionsById.size),
  };
}
