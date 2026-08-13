import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { Metadata } from '@/api/types';
import type { TerminalAttachmentId, TerminalHostHandle } from '@/integrations/terminalHost/_types';

export type LegacyTerminalAttachmentInfo = {
  version: 1;
  sessionId: string;
  terminal: NonNullable<Metadata['terminal']>;
  updatedAt: number;
};

export type BoundTerminalAttachmentInfo = {
  version: 2;
  attachmentId: TerminalAttachmentId;
  sessionId: string;
  handle: TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>;
  terminal: NonNullable<Metadata['terminal']>;
  updatedAt: number;
};

export type TerminalAttachmentInfo = LegacyTerminalAttachmentInfo | BoundTerminalAttachmentInfo;

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

function legacySessionFilePath(happyHomeDir: string, sessionId: string): string {
  return join(sessionsDir(happyHomeDir), `${sessionId}.json`);
}

function normalizeOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function terminalRootMatchesHandle(
  terminal: NonNullable<Metadata['terminal']>,
  handle: TerminalHostHandle,
): boolean {
  if (
    handle.attachMetadata.attachStrategy !== 'terminal_host'
    || (handle.attachMetadata.topology !== 'shared' && handle.attachMetadata.topology !== 'exclusive')
  ) {
    return false;
  }
  const sessionName = handle.sessionName.trim();
  const paneId = normalizeOptionalString(handle.paneId);
  const socketDir = normalizeOptionalString(handle.socketDir);
  if (!sessionName) return false;

  if (handle.kind === 'tmux') {
    if (terminal.mode !== 'tmux') return false;
    const expectedTarget = paneId ? `${sessionName}:${paneId}` : sessionName;
    const persistedRoot = normalizeOptionalString(terminal.tmux?.tmpDir);
    return normalizeOptionalString(terminal.tmux?.target) === expectedTarget
      && persistedRoot === socketDir;
  }
  if (handle.kind === 'zellij') {
    if (terminal.mode !== 'zellij') return false;
    return normalizeOptionalString(terminal.zellij?.sessionName) === sessionName
      && normalizeOptionalString(terminal.zellij?.paneId) === paneId
      && normalizeOptionalString(terminal.zellij?.socketDirV1) === socketDir;
  }
  return handle.kind === 'windows_console' && terminal.mode === 'windows_console';
}

function parseTerminalAttachmentInfo(raw: string, sessionId: string): TerminalAttachmentInfo | null {
  const parsed = JSON.parse(raw) as Partial<TerminalAttachmentInfo> | null;
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.sessionId !== sessionId) return null;
  if (!parsed.terminal || typeof parsed.terminal !== 'object') return null;
  if (
    parsed.terminal.mode !== 'plain'
    && parsed.terminal.mode !== 'tmux'
    && parsed.terminal.mode !== 'zellij'
    && parsed.terminal.mode !== 'windows_terminal'
    && parsed.terminal.mode !== 'windows_console'
  ) {
    return null;
  }
  if (parsed.version === 1) return parsed as LegacyTerminalAttachmentInfo;
  if (parsed.version !== 2) return null;
  const candidate = parsed as Partial<BoundTerminalAttachmentInfo>;
  if (!candidate.terminal) return null;
  if (typeof candidate.attachmentId !== 'string' || candidate.attachmentId.trim().length === 0) return null;
  if (!candidate.handle || typeof candidate.handle !== 'object') return null;
  if (candidate.handle.attachmentId !== candidate.attachmentId) return null;
  if (candidate.handle.kind !== 'tmux' && candidate.handle.kind !== 'zellij' && candidate.handle.kind !== 'windows_console') return null;
  if (typeof candidate.handle.sessionName !== 'string' || candidate.handle.sessionName.trim().length === 0) return null;
  if (!terminalRootMatchesHandle(candidate.terminal, candidate.handle)) return null;
  return candidate as BoundTerminalAttachmentInfo;
}

function terminalMatchesExpected(
  terminal: NonNullable<Metadata['terminal']>,
  expectedTerminal: NonNullable<Metadata['terminal']> | undefined,
): boolean {
  if (!expectedTerminal) return true;
  return JSON.stringify(terminal) === JSON.stringify(expectedTerminal);
}

async function removeTerminalAttachmentInfoPath(params: {
  path: string;
  sessionId: string;
  expectedAttachmentId?: TerminalAttachmentId | string | undefined;
  expectedTerminal?: NonNullable<Metadata['terminal']> | undefined;
  /** Allow removing a v1 record by terminal metadata match only (no attachmentId CAS). */
  legacyTerminalMetadataRemoval?: boolean;
}): Promise<boolean> {
  try {
    const raw = await readFile(params.path, 'utf8');
    const parsed = parseTerminalAttachmentInfo(raw, params.sessionId);
    if (!parsed) return false;

    if (params.legacyTerminalMetadataRemoval && parsed.version === 1) {
      // For v1 (legacy) records: allow removal by terminal metadata deep-equality only.
      // This is deliberately narrow — the caller must prove the host is dead before using this.
      if (!params.expectedTerminal) return false;
      if (!terminalMatchesExpected(parsed.terminal, params.expectedTerminal)) return false;
      await unlink(params.path);
      return true;
    }

    if (!params.expectedAttachmentId) return false;
    if (parsed.version !== 2 || parsed.attachmentId !== params.expectedAttachmentId) return false;
    if (!terminalMatchesExpected(parsed.terminal, params.expectedTerminal)) return false;
    await unlink(params.path);
    return true;
  } catch {
    return false;
  }
}

export async function writeTerminalAttachmentInfo(params: {
  happyHomeDir: string;
  sessionId: string;
  attachmentId?: TerminalAttachmentId | string | undefined;
  handle?: TerminalHostHandle | undefined;
  terminal: NonNullable<Metadata['terminal']>;
}): Promise<void> {
  const dir = sessionsDir(params.happyHomeDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Best-effort: mkdir does not update permissions for existing dirs.
  await chmod(dir, 0o700).catch(() => {});

  const attachmentId = typeof params.attachmentId === 'string' && params.attachmentId.trim().length > 0
    ? params.attachmentId as TerminalAttachmentId
    : null;
  if (attachmentId && params.handle && !terminalRootMatchesHandle(params.terminal, params.handle)) {
    throw new Error('Terminal attachment root does not match its bound host handle');
  }
  const info: TerminalAttachmentInfo = attachmentId && params.handle
    ? {
        version: 2,
        attachmentId,
        sessionId: params.sessionId,
        handle: { ...params.handle, attachmentId },
        terminal: params.terminal,
        updatedAt: Date.now(),
      }
    : {
        version: 1,
        sessionId: params.sessionId,
        terminal: params.terminal,
        updatedAt: Date.now(),
      };

  const path = sessionFilePath(params.happyHomeDir, params.sessionId);
  const tmpPath = `${path}.tmp`;

  await writeFile(tmpPath, JSON.stringify(info, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(tmpPath, path);
  await chmod(path, 0o600).catch(() => {});
}

export async function removeTerminalAttachmentInfo(params: {
  happyHomeDir: string;
  sessionId: string;
  expectedAttachmentId?: TerminalAttachmentId | string | undefined;
  expectedTerminal?: NonNullable<Metadata['terminal']> | undefined;
  /** Allow removing a v1 record by terminal metadata match only (no attachmentId CAS). */
  legacyTerminalMetadataRemoval?: boolean;
}): Promise<boolean> {
  const encodedPath = sessionFilePath(params.happyHomeDir, params.sessionId);
  if (await removeTerminalAttachmentInfoPath({
    path: encodedPath,
    sessionId: params.sessionId,
    expectedAttachmentId: params.expectedAttachmentId,
    expectedTerminal: params.expectedTerminal,
    legacyTerminalMetadataRemoval: params.legacyTerminalMetadataRemoval,
  })) {
    return true;
  }
  if (params.sessionId.includes('/') || params.sessionId.includes('\\')) return false;
  const legacyPath = legacySessionFilePath(params.happyHomeDir, params.sessionId);
  if (legacyPath === encodedPath) return false;
  return removeTerminalAttachmentInfoPath({
    path: legacyPath,
    sessionId: params.sessionId,
    expectedAttachmentId: params.expectedAttachmentId,
    expectedTerminal: params.expectedTerminal,
    legacyTerminalMetadataRemoval: params.legacyTerminalMetadataRemoval,
  });
}

export async function readTerminalAttachmentInfo(params: {
  happyHomeDir: string;
  sessionId: string;
}): Promise<TerminalAttachmentInfo | null> {
  const state = await readTerminalAttachmentState(params);
  return state.status === 'present' ? state.info : null;
}

export type TerminalAttachmentReadState =
  | Readonly<{ status: 'absent' }>
  | Readonly<{ status: 'present'; info: TerminalAttachmentInfo }>
  | Readonly<{ status: 'unreadable'; reason: 'invalid' | 'io_error' }>;

async function readAttachmentFileState(path: string, sessionId: string): Promise<TerminalAttachmentReadState> {
  try {
    const raw = await readFile(path, 'utf8');
    try {
      const info = parseTerminalAttachmentInfo(raw, sessionId);
      return info ? { status: 'present', info } : { status: 'unreadable', reason: 'invalid' };
    } catch {
      return { status: 'unreadable', reason: 'invalid' };
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
      ? { status: 'absent' }
      : { status: 'unreadable', reason: 'io_error' };
  }
}

export async function readTerminalAttachmentState(params: {
  happyHomeDir: string;
  sessionId: string;
}): Promise<TerminalAttachmentReadState> {
  const encodedPath = sessionFilePath(params.happyHomeDir, params.sessionId);
  const encoded = await readAttachmentFileState(encodedPath, params.sessionId);
  if (encoded.status !== 'absent') return encoded;

  // Only allow legacy fallback for filename-safe session ids. The legacy filename
  // used the raw sessionId, so path separators would allow traversal outside the
  // intended sessions directory.
  if (params.sessionId.includes('/') || params.sessionId.includes('\\')) return encoded;
  const legacyPath = legacySessionFilePath(params.happyHomeDir, params.sessionId);
  return legacyPath === encodedPath
    ? encoded
    : await readAttachmentFileState(legacyPath, params.sessionId);
}
