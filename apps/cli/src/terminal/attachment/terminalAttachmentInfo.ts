import { chmod, mkdir, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Metadata } from '@/api/types';
import type { TerminalHostHandle } from '@happier-dev/agents';
import { withJsonOwnerFileLock } from '@/utils/fs/jsonOwnerFileLock';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';
import type { BorrowedTerminalProcessIdentity } from '@/terminal/host/borrowedTerminalProcess';

const TERMINAL_HOST_DESCRIPTOR_LOCK_TIMEOUT_MS = 5_000;
const TERMINAL_HOST_DESCRIPTOR_LOCK_STALE_AFTER_MS = 30_000;
const TERMINAL_ATTACHMENT_METADATA_LOCK_TIMEOUT_MS = 5_000;
const TERMINAL_ATTACHMENT_METADATA_LOCK_STALE_AFTER_MS = 30_000;

export type TerminalAttachmentInfo = {
  version: 1;
  sessionId: string;
  terminal: NonNullable<Metadata['terminal']>;
  updatedAt: number;
};

export type TerminalAttachmentId = NonNullable<TerminalHostHandle['attachmentId']>;

export type LegacyTerminalHostAttachmentInfo = Readonly<{
  version: 1;
  sessionId: string;
  handle: TerminalHostHandle;
  updatedAt: number;
}>;

export type BoundTerminalHostAttachmentInfo = Readonly<{
  version: 2;
  attachmentId: TerminalAttachmentId;
  sessionId: string;
  handle: TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>;
  updatedAt: number;
}>;

export type BorrowedTerminalHostAttachmentInfo = Readonly<{
  version: 3;
  lifecycle: 'borrowed';
  nativeClientProcess?: BorrowedTerminalProcessIdentity;
  attachmentId: TerminalAttachmentId;
  sessionId: string;
  handle: TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>;
  updatedAt: number;
}>;

export type ExactTerminalHostAttachmentInfo = BoundTerminalHostAttachmentInfo | BorrowedTerminalHostAttachmentInfo;
export type TerminalHostAttachmentInfo = LegacyTerminalHostAttachmentInfo | ExactTerminalHostAttachmentInfo;

export type TerminalHostAttachmentReadState =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'present'; info: TerminalHostAttachmentInfo }>
  | Readonly<{ status: 'unreadable'; reason: 'invalid' | 'io_error' }>;

export function createTerminalAttachmentId(): TerminalAttachmentId {
  return randomUUID() as TerminalAttachmentId;
}

function sessionsDir(happyHomeDir: string): string {
  return join(happyHomeDir, 'terminal', 'sessions');
}

function sessionIdToFilename(sessionId: string): string {
  return encodeURIComponent(sessionId);
}

function sessionFilePath(happyHomeDir: string, sessionId: string): string {
  return join(sessionsDir(happyHomeDir), `${sessionIdToFilename(sessionId)}.json`);
}

function terminalHostFilePath(happyHomeDir: string, sessionId: string): string {
  return join(sessionsDir(happyHomeDir), `${sessionIdToFilename(sessionId)}.host.json`);
}

async function withTerminalAttachmentMetadataLock<TResult>(
  path: string,
  effect: () => Promise<TResult>,
): Promise<TResult> {
  return await withJsonOwnerFileLock({
    lockPath: `${path}.lock`,
    timeoutMs: TERMINAL_ATTACHMENT_METADATA_LOCK_TIMEOUT_MS,
    staleAfterMs: TERMINAL_ATTACHMENT_METADATA_LOCK_STALE_AFTER_MS,
    errorCode: 'terminal_attachment_metadata_lock_unavailable',
  }, effect);
}

async function withTerminalHostDescriptorLock<TResult>(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
}>, effect: () => Promise<TResult>): Promise<TResult> {
  return await withJsonOwnerFileLock({
    lockPath: `${terminalHostFilePath(params.happyHomeDir, params.sessionId)}.lock`,
    timeoutMs: TERMINAL_HOST_DESCRIPTOR_LOCK_TIMEOUT_MS,
    staleAfterMs: TERMINAL_HOST_DESCRIPTOR_LOCK_STALE_AFTER_MS,
    errorCode: 'terminal_host_descriptor_lock_unavailable',
  }, effect);
}

function legacySessionFilePath(happyHomeDir: string, sessionId: string): string {
  return join(sessionsDir(happyHomeDir), `${sessionId}.json`);
}

export async function writeTerminalAttachmentInfo(params: {
  happyHomeDir: string;
  sessionId: string;
  terminal: NonNullable<Metadata['terminal']>;
}): Promise<void> {
  const dir = sessionsDir(params.happyHomeDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Best-effort: mkdir does not update permissions for existing dirs.
  await chmod(dir, 0o700).catch(() => {});

  const info: TerminalAttachmentInfo = {
    version: 1,
    sessionId: params.sessionId,
    terminal: params.terminal,
    updatedAt: Date.now(),
  };

  const path = sessionFilePath(params.happyHomeDir, params.sessionId);
  await withTerminalAttachmentMetadataLock(path, async () => {
    await writeJsonAtomic(path, info);
  });
}

function parseTerminalHostHandle(value: unknown): TerminalHostHandle | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'tmux' && record.kind !== 'zellij' && record.kind !== 'herdr' && record.kind !== 'windows_console') return null;
  if (typeof record.sessionName !== 'string' || !record.sessionName.trim()) return null;
  if (record.kind === 'herdr' && (
    typeof record.socketPath !== 'string' || !record.socketPath.trim()
    || typeof record.terminalId !== 'string' || !record.terminalId.trim()
  )) return null;
  const attachMetadata = record.attachMetadata;
  if (!attachMetadata || typeof attachMetadata !== 'object' || Array.isArray(attachMetadata)) return null;
  const metadata = attachMetadata as Record<string, unknown>;
  if (metadata.attachStrategy !== 'terminal_host') return null;
  if (metadata.topology !== 'exclusive' && metadata.topology !== 'shared') return null;
  const expectedCommandFragments = Array.isArray(record.expectedCommandFragments)
    && record.expectedCommandFragments.every((fragment) => typeof fragment === 'string')
    ? record.expectedCommandFragments as string[]
    : undefined;
  return {
    ...(typeof record.attachmentId === 'string' && record.attachmentId.trim()
      ? { attachmentId: record.attachmentId as TerminalAttachmentId }
      : {}),
    kind: record.kind,
    sessionName: record.sessionName,
    ...(typeof record.paneId === 'string' && record.paneId ? { paneId: record.paneId } : {}),
    ...(typeof record.socketDir === 'string' && record.socketDir ? { socketDir: record.socketDir } : {}),
    ...(typeof record.socketPath === 'string' && record.socketPath ? { socketPath: record.socketPath } : {}),
    ...(typeof record.terminalId === 'string' && record.terminalId ? { terminalId: record.terminalId } : {}),
    ...(expectedCommandFragments ? { expectedCommandFragments } : {}),
    attachMetadata: {
      attachStrategy: 'terminal_host',
      topology: metadata.topology,
      ...(metadata.locality === 'same_machine'
        || metadata.locality === 'session_machine'
        || metadata.locality === 'network_reachable'
        ? { locality: metadata.locality }
        : {}),
      ...(typeof metadata.maxClients === 'number' || metadata.maxClients === null
        ? { maxClients: metadata.maxClients }
        : {}),
      ...(typeof metadata.requiresLocalAttachmentInfo === 'boolean'
        ? { requiresLocalAttachmentInfo: metadata.requiresLocalAttachmentInfo }
        : {}),
      ...(metadata.liveProbe === 'none' || metadata.liveProbe === 'optional' || metadata.liveProbe === 'required'
        ? { liveProbe: metadata.liveProbe }
        : {}),
    },
  };
}

function terminalHostHandlesEqual(left: TerminalHostHandle, right: TerminalHostHandle): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseNativeClientProcess(value: unknown): BorrowedTerminalProcessIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return typeof record.pid === 'number' && Number.isInteger(record.pid) && record.pid > 0
    && typeof record.processInstanceFingerprint === 'string' && record.processInstanceFingerprint.trim()
    ? { pid: record.pid, processInstanceFingerprint: record.processInstanceFingerprint } : null;
}

export function terminalMetadataMatchesHostHandle(
  terminal: NonNullable<Metadata['terminal']>,
  handle: TerminalHostHandle,
  knownAttachmentId: string | undefined = terminal.controlServiceabilityV1?.attachmentId,
): boolean {
  const socketDir = typeof handle.socketDir === 'string' ? handle.socketDir.trim() : '';
  if (handle.kind === 'tmux') {
    const paneId = typeof handle.paneId === 'string' ? handle.paneId.trim() : '';
    const target = paneId ? `${handle.sessionName.trim()}:${paneId}` : handle.sessionName.trim();
    const persistedTmpDir = typeof terminal.tmux?.tmpDir === 'string' ? terminal.tmux.tmpDir.trim() : '';
    return terminal.mode === 'tmux'
      && terminal.tmux?.target.trim() === target
      && persistedTmpDir === socketDir;
  }
  if (handle.kind === 'zellij') {
    const terminalRecord = terminal as typeof terminal & Readonly<{
      zellij?: Readonly<{ sessionName?: unknown; paneId?: unknown; socketDirV1?: unknown }>;
    }>;
    const sessionName = typeof terminalRecord.zellij?.sessionName === 'string'
      ? terminalRecord.zellij.sessionName.trim()
      : '';
    const paneId = typeof terminalRecord.zellij?.paneId === 'string'
      ? terminalRecord.zellij.paneId.trim()
      : '';
    const persistedSocketDir = typeof terminalRecord.zellij?.socketDirV1 === 'string'
      ? terminalRecord.zellij.socketDirV1.trim()
      : '';
    return terminal.mode === 'zellij'
      && sessionName === handle.sessionName.trim()
      && paneId === (handle.paneId?.trim() ?? '')
      && persistedSocketDir === socketDir;
  }
  if (handle.kind === 'herdr') {
    return terminal.mode === 'herdr'
      && terminal.herdr?.sessionName === handle.sessionName.trim()
      && terminal.herdr?.socketPath === handle.socketPath?.trim()
      && terminal.herdr?.terminalId === handle.terminalId?.trim();
  }
  if (handle.kind === 'windows_console') {
    // PTY metadata has no reconstructible host geometry; its committed ID is the binding.
    const attachmentId = knownAttachmentId?.trim();
    return terminal.mode === 'windows_console' && terminal.windows?.host === 'console'
      && Boolean(attachmentId) && attachmentId === handle.attachmentId;
  }
  return false;
}

function parseRemoteDevExactTerminalAttachmentInfo(
  raw: string,
  sessionId: string,
): ExactTerminalHostAttachmentInfo | null {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if ((parsed.version !== 2 && parsed.version !== 3) || parsed.sessionId !== sessionId) return null;
  if (parsed.version === 3 && parsed.lifecycle !== 'borrowed') return null;
  const nativeClientProcess = parsed.nativeClientProcess === undefined ? undefined : parseNativeClientProcess(parsed.nativeClientProcess);
  if (parsed.nativeClientProcess !== undefined && (parsed.version !== 3 || !nativeClientProcess)) return null;
  if (typeof parsed.attachmentId !== 'string' || !parsed.attachmentId.trim()) return null;
  if (typeof parsed.updatedAt !== 'number' || !Number.isFinite(parsed.updatedAt)) return null;
  if (!parsed.terminal || typeof parsed.terminal !== 'object' || Array.isArray(parsed.terminal)) return null;
  const terminal = parsed.terminal as NonNullable<Metadata['terminal']>;
  const handle = parseTerminalHostHandle(parsed.handle);
  if (!handle || handle.attachmentId !== parsed.attachmentId) return null;
  if (!terminalMetadataMatchesHostHandle(terminal, handle)) return null;
  const exactBase = {
    attachmentId: parsed.attachmentId as TerminalAttachmentId,
    sessionId,
    handle: handle as TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>,
    updatedAt: parsed.updatedAt,
  };
  return parsed.version === 3
    ? { version: 3, lifecycle: 'borrowed', ...exactBase, ...(nativeClientProcess ? { nativeClientProcess } : {}) }
    : { version: 2, ...exactBase };
}

async function readRemoteDevBoundTerminalAttachmentState(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
}>): Promise<TerminalHostAttachmentReadState> {
  const encodedPath = sessionFilePath(params.happyHomeDir, params.sessionId);
  const paths = [encodedPath];
  if (!params.sessionId.includes('/') && !params.sessionId.includes('\\')) {
    const legacyPath = legacySessionFilePath(params.happyHomeDir, params.sessionId);
    if (legacyPath !== encodedPath) paths.push(legacyPath);
  }
  for (const path of paths) {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') continue;
      return { status: 'unreadable', reason: 'io_error' };
    }
    try {
      const parsedRaw = JSON.parse(raw) as { version?: unknown };
      if (parsedRaw.version !== 2 && parsedRaw.version !== 3) return { status: 'absent' };
      const info = parseRemoteDevExactTerminalAttachmentInfo(raw, params.sessionId);
      return info
        ? { status: 'present', info }
        : { status: 'unreadable', reason: 'invalid' };
    } catch {
      return { status: 'unreadable', reason: 'invalid' };
    }
  }
  return { status: 'absent' };
}

export async function writeTerminalHostAttachmentInfo(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  handle: TerminalHostHandle;
  lifecycle?: 'owned' | 'borrowed';
  nativeClientProcess?: BorrowedTerminalProcessIdentity;
}>): Promise<ExactTerminalHostAttachmentInfo> {
  const handle = parseTerminalHostHandle(params.handle);
  if (!handle) throw new Error('Invalid terminal host handle');
  const nativeClientProcess = params.nativeClientProcess === undefined ? undefined : parseNativeClientProcess(params.nativeClientProcess);
  if (params.nativeClientProcess !== undefined && (params.lifecycle !== 'borrowed' || !nativeClientProcess)) {
    throw new Error('Invalid borrowed terminal client custody');
  }
  const attachmentId = handle.attachmentId ?? createTerminalAttachmentId();
  const boundHandle = { ...handle, attachmentId };
  const dir = sessionsDir(params.happyHomeDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  const info: ExactTerminalHostAttachmentInfo = params.lifecycle === 'borrowed'
    ? {
        version: 3,
        lifecycle: 'borrowed',
        ...(nativeClientProcess ? { nativeClientProcess } : {}),
        attachmentId,
        sessionId: params.sessionId,
        handle: boundHandle,
        updatedAt: Date.now(),
      }
    : {
        version: 2,
        attachmentId,
        sessionId: params.sessionId,
        handle: boundHandle,
        updatedAt: Date.now(),
      };
  await withTerminalHostDescriptorLock(params, async () => {
    await writeJsonAtomic(terminalHostFilePath(params.happyHomeDir, params.sessionId), info);
  });
  return info;
}

export async function readTerminalHostAttachmentState(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
}>): Promise<TerminalHostAttachmentReadState> {
  let raw: string;
  try {
    raw = await readFile(terminalHostFilePath(params.happyHomeDir, params.sessionId), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? await readRemoteDevBoundTerminalAttachmentState(params)
      : { status: 'unreadable', reason: 'io_error' };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const handle = parseTerminalHostHandle(parsed.handle);
    if ((parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) || parsed.sessionId !== params.sessionId || !handle) {
      return { status: 'unreadable', reason: 'invalid' };
    }
    if (typeof parsed.updatedAt !== 'number' || !Number.isFinite(parsed.updatedAt)) {
      return { status: 'unreadable', reason: 'invalid' };
    }
    if (parsed.version === 2 || parsed.version === 3) {
      if (typeof parsed.attachmentId !== 'string' || !parsed.attachmentId.trim()) {
        return { status: 'unreadable', reason: 'invalid' };
      }
      if (parsed.version === 3 && parsed.lifecycle !== 'borrowed') {
        return { status: 'unreadable', reason: 'invalid' };
      }
      const nativeClientProcess = parsed.nativeClientProcess === undefined ? undefined : parseNativeClientProcess(parsed.nativeClientProcess);
      if (parsed.nativeClientProcess !== undefined && (parsed.version !== 3 || !nativeClientProcess)) {
        return { status: 'unreadable', reason: 'invalid' };
      }
      if (handle.attachmentId !== parsed.attachmentId) {
        return { status: 'unreadable', reason: 'invalid' };
      }
      const exactBase = {
          attachmentId: parsed.attachmentId as TerminalAttachmentId,
          sessionId: params.sessionId,
          handle: handle as TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>,
          updatedAt: parsed.updatedAt,
      };
      return parsed.version === 3
        ? { status: 'present', info: { version: 3, lifecycle: 'borrowed', ...exactBase, ...(nativeClientProcess ? { nativeClientProcess } : {}) } }
        : { status: 'present', info: { version: 2, ...exactBase } };
    }
    return { status: 'present', info: {
        version: 1,
        sessionId: params.sessionId,
        handle,
        updatedAt: parsed.updatedAt,
      } };
  } catch {
    return { status: 'unreadable', reason: 'invalid' };
  }
}

export async function readTerminalHostAttachmentInfo(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
}>): Promise<TerminalHostAttachmentInfo | null> {
  const state = await readTerminalHostAttachmentState(params);
  return state.status === 'present' ? state.info : null;
}

async function removeRemoteDevBoundTerminalAttachmentInfo(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  expectedHandle?: TerminalHostHandle;
  expectedAttachmentId?: TerminalAttachmentId | string;
}>): Promise<boolean> {
  const encodedPath = sessionFilePath(params.happyHomeDir, params.sessionId);
  const paths = [encodedPath];
  if (!params.sessionId.includes('/') && !params.sessionId.includes('\\')) {
    const legacyPath = legacySessionFilePath(params.happyHomeDir, params.sessionId);
    if (legacyPath !== encodedPath) paths.push(legacyPath);
  }
  for (const path of paths) {
    const removed = await withTerminalAttachmentMetadataLock(path, async () => {
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
        throw error;
      }
      const current = parseRemoteDevExactTerminalAttachmentInfo(raw, params.sessionId);
      if (!current) return false;
      const expectedAttachmentId = params.expectedAttachmentId ?? params.expectedHandle?.attachmentId;
      if (!expectedAttachmentId || current.attachmentId !== expectedAttachmentId) return false;
      if (params.expectedHandle && !terminalHostHandlesEqual(current.handle, params.expectedHandle)) return false;
      await unlink(path);
      return true;
    });
    if (removed) return true;
  }
  return false;
}

export async function removeTerminalHostAttachmentInfo(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  expectedHandle?: TerminalHostHandle;
  expectedAttachmentId?: TerminalAttachmentId | string;
}>): Promise<boolean> {
  return await withTerminalHostDescriptorLock(params, async () => {
    const current = await readTerminalHostAttachmentInfo(params);
    if (!current) return false;
    const expectedHandle = params.expectedHandle ? parseTerminalHostHandle(params.expectedHandle) : null;
    if (current.version === 2 || current.version === 3) {
      const expectedAttachmentId = params.expectedAttachmentId ?? expectedHandle?.attachmentId;
      if (!expectedAttachmentId || current.attachmentId !== expectedAttachmentId) return false;
    } else if (!expectedHandle || !terminalHostHandlesEqual(current.handle, expectedHandle)) {
      return false;
    }
    try {
      await unlink(terminalHostFilePath(params.happyHomeDir, params.sessionId));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return await removeRemoteDevBoundTerminalAttachmentInfo({
          ...params,
          expectedHandle: expectedHandle ?? undefined,
        });
      }
      throw error;
    }
  });
}

function parseTerminalAttachmentInfo(
  raw: string,
  sessionId: string,
): TerminalAttachmentInfo | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if ((parsed.version !== 1 && parsed.version !== 2 && parsed.version !== 3) || parsed.sessionId !== sessionId) return null;
    if (!parsed.terminal || typeof parsed.terminal !== 'object') return null;
    const terminal = parsed.terminal as NonNullable<Metadata['terminal']>;
    if (
      terminal.mode !== 'plain'
      && terminal.mode !== 'tmux'
      && terminal.mode !== 'zellij'
      && terminal.mode !== 'herdr'
      && terminal.mode !== 'windows_terminal'
      && terminal.mode !== 'windows_console'
    ) {
      return null;
    }
    if (typeof parsed.updatedAt !== 'number' || !Number.isFinite(parsed.updatedAt)) return null;
    if ((parsed.version === 2 || parsed.version === 3) && !parseRemoteDevExactTerminalAttachmentInfo(raw, sessionId)) return null;
    return {
      version: 1,
      sessionId,
      terminal,
      updatedAt: parsed.updatedAt,
    };
  } catch {
    return null;
  }
}

function terminalAttachmentSnapshotsEqual(
  current: TerminalAttachmentInfo,
  expected: TerminalAttachmentInfo,
): boolean {
  return JSON.stringify(current) === JSON.stringify(expected);
}

async function removeTerminalAttachmentInfoPath(params: Readonly<{
  path: string;
  sessionId: string;
  expected: TerminalAttachmentInfo;
}>): Promise<boolean> {
  return await withTerminalAttachmentMetadataLock(params.path, async () => {
    let raw: string;
    try {
      raw = await readFile(params.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
      throw error;
    }
    const current = parseTerminalAttachmentInfo(raw, params.sessionId);
    if (!current || !terminalAttachmentSnapshotsEqual(current, params.expected)) return false;
    try {
      await unlink(params.path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return false;
      throw error;
    }
  });
}

export async function removeTerminalAttachmentInfo(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
  expected: TerminalAttachmentInfo;
}>): Promise<boolean> {
  const encodedPath = sessionFilePath(params.happyHomeDir, params.sessionId);
  if (await removeTerminalAttachmentInfoPath({
    path: encodedPath,
    sessionId: params.sessionId,
    expected: params.expected,
  })) {
    return true;
  }
  if (params.sessionId.includes('/') || params.sessionId.includes('\\')) return false;
  const legacyPath = legacySessionFilePath(params.happyHomeDir, params.sessionId);
  if (legacyPath === encodedPath) return false;
  return await removeTerminalAttachmentInfoPath({
    path: legacyPath,
    sessionId: params.sessionId,
    expected: params.expected,
  });
}

export async function disposeTerminalAttachmentInfoForSession(params: Readonly<{
  happyHomeDir: string;
  sessionId: string;
}>): Promise<void> {
  // Exact host descriptors are attachment state. Only terminal-host disposition may retire them.
  const encodedPath = sessionFilePath(params.happyHomeDir, params.sessionId);
  const paths = [encodedPath];
  if (!params.sessionId.includes('/') && !params.sessionId.includes('\\')) {
    const legacyPath = legacySessionFilePath(params.happyHomeDir, params.sessionId);
    if (legacyPath !== encodedPath) paths.push(legacyPath);
  }
  await Promise.all(paths.map(async (path) => {
    await withTerminalAttachmentMetadataLock(path, async () => {
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
        throw error;
      }
      // Remote Dev stored exact v2/v3 host descriptors at the display-metadata
      // path. Preserve supported predecessors until terminal-host disposition
      // proves and retires the exact host.
      if (parseRemoteDevExactTerminalAttachmentInfo(raw, params.sessionId)) return;
      await unlink(path);
    });
  }));
}

export async function readTerminalAttachmentInfo(params: {
  happyHomeDir: string;
  sessionId: string;
}): Promise<TerminalAttachmentInfo | null> {
  try {
    const encodedPath = sessionFilePath(params.happyHomeDir, params.sessionId);
    let raw: string;
    try {
      raw = await readFile(encodedPath, 'utf8');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err?.code !== 'ENOENT') throw e;
      // Only allow legacy fallback for filename-safe session ids. The legacy filename
      // used the raw sessionId, so path separators would allow traversal outside the
      // intended sessions directory.
      if (params.sessionId.includes('/') || params.sessionId.includes('\\')) throw e;
      const legacyPath = legacySessionFilePath(params.happyHomeDir, params.sessionId);
      if (legacyPath === encodedPath) throw e;
      raw = await readFile(legacyPath, 'utf8');
    }
    return parseTerminalAttachmentInfo(raw, params.sessionId);
  } catch {
    return null;
  }
}
