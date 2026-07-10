import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import {
  findNewestSessionFileInDir,
  isBareSessionFileId,
  parseSessionIdFromFileName,
  sessionFileNameMatchesSessionId,
} from '@happier-dev/plugin-sdk/experimental/sessions/fileStores';

import { PI_SESSION_FILE_STORE_DESCRIPTOR_V1 } from './sessionFileStoreDescriptor.js';

const LEGACY_PI_WORKDIR_SEGMENT = '--workdir--';

export function doesPiSessionFileNameMatchSessionId(fileName: string, sessionId: string): boolean {
  return sessionFileNameMatchesSessionId(fileName, sessionId);
}

export function isBarePiSessionId(value: string): boolean {
  return isBareSessionFileId(value);
}

export function encodePiSessionDirectoryCwd(cwd: string): string {
  const encoded = PI_SESSION_FILE_STORE_DESCRIPTOR_V1.encodeCwdSubdir?.(cwd) ?? '';
  return encoded.startsWith('--') && encoded.endsWith('--') ? encoded.slice(2, -2) : encoded;
}

export function formatPiSessionDirectoryForCwd(cwd: string): string {
  return PI_SESSION_FILE_STORE_DESCRIPTOR_V1.encodeCwdSubdir?.(cwd) ?? `--${encodePiSessionDirectoryCwd(cwd)}--`;
}

export function resolvePiSessionIdFromResumeReference(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (isBarePiSessionId(trimmed)) return trimmed;
  return parseSessionIdFromFileName(basename(trimmed));
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export async function pathExistsAsFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function findNewestPiSessionFileInDir(params: Readonly<{
  sessionId: string;
  dir: string;
}>): Promise<string | null> {
  return await findNewestSessionFileInDir(params);
}

export function buildPiResumeSearchRoots(params: Readonly<{
  cwd: string;
  env?: Readonly<Record<string, string | undefined>> | null;
  targetMaterializedRoot?: string | null;
  candidatePersistedSessionFile?: string | null;
  targetStrict?: boolean;
}>): string[] {
  const encodedCwdDir = formatPiSessionDirectoryForCwd(params.cwd);
  const env = params.env ?? {};
  const piAgentDir = nonEmptyString(env[PI_SESSION_FILE_STORE_DESCRIPTOR_V1.agentDirEnvVar]);
  const legacySessionDir = PI_SESSION_FILE_STORE_DESCRIPTOR_V1.legacySessionDirEnvVars
    .map((envVar) => nonEmptyString(env[envVar]))
    .find((value): value is string => value != null) ?? null;
  const persisted = nonEmptyString(params.candidatePersistedSessionFile);
  const persistedDir = persisted && isAbsolute(persisted) ? dirname(persisted) : null;
  const targetRoot = nonEmptyString(params.targetMaterializedRoot);
  const defaultAgentDir = join(homedir(), ...PI_SESSION_FILE_STORE_DESCRIPTOR_V1.defaultAgentDirSegments);

  if (params.targetStrict) {
    return piAgentDir ? [join(piAgentDir, 'sessions', encodedCwdDir)] : [];
  }

  const roots = [
    ...(persistedDir ? [persistedDir] : []),
    ...(piAgentDir ? [join(piAgentDir, 'sessions', encodedCwdDir), join(piAgentDir, 'sessions')] : []),
    join(defaultAgentDir, 'sessions', encodedCwdDir),
    join(defaultAgentDir, 'sessions'),
    ...(legacySessionDir ? [join(legacySessionDir, LEGACY_PI_WORKDIR_SEGMENT), legacySessionDir] : []),
    ...(targetRoot ? [
      join(targetRoot, 'pi-agent-dir', 'sessions', encodedCwdDir),
      join(targetRoot, 'pi-sessions', LEGACY_PI_WORKDIR_SEGMENT),
      join(targetRoot, 'pi-sessions'),
    ] : []),
  ];

  return Array.from(new Set(roots));
}

export async function findPiSessionFileForId(params: Readonly<{
  sessionId: string;
  roots: readonly string[];
}>): Promise<string | null> {
  for (const dir of params.roots) {
    const found = await findNewestPiSessionFileInDir({ sessionId: params.sessionId, dir });
    if (found) return found;
  }
  return null;
}
