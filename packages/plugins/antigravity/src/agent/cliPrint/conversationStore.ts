import { lstat, opendir, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import type { JsonlScannerFileSystem } from '@happier-dev/plugin-sdk/sessions/file-stores';
import { isCanonicalAbsolutePathInsideRoot } from '@happier-dev/plugin-sdk/fs';

import {
  readAntigravityTranscriptHeadRecord,
  snapshotAntigravityTranscriptSource,
} from './transcript/jsonl.js';
import { mapAntigravityTranscriptRecordToSteps } from './transcript/mapper.js';

export type AntigravityConversationDiscovery =
  | Readonly<{ status: 'found'; conversationId: string }>
  | Readonly<{ status: 'not_found' }>
  | Readonly<{ status: 'ambiguous'; candidates: readonly string[] }>;

function readNonEmptyEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveAntigravityBrainDir(
  env: Readonly<Record<string, string | undefined>> = {},
): string {
  const home = readNonEmptyEnv(env.HOME)
    ?? readNonEmptyEnv(env.USERPROFILE)
    ?? homedir();
  return join(home, '.gemini', 'antigravity-cli', 'brain');
}

export function resolveAntigravityTranscriptFullPath(
  brainDir: string,
  conversationId: string,
): string {
  return join(brainDir, conversationId, '.system_generated', 'logs', 'transcript_full.jsonl');
}

export function isSafeAntigravityConversationId(value: string): boolean {
  return value.length > 0
    && value !== '.'
    && value !== '..'
    && !value.includes('/')
    && !value.includes('\\')
    && !value.includes('\0');
}

/**
 * The single physical authorization decision for an Antigravity transcript.
 * A configured brain root may itself be a symlink, but every identity below it
 * has to resolve to one regular file inside that root's physical tree. Exact
 * lookups, transcript reads, and observation all consume the returned path so
 * candidate discovery cannot be bypassed with a syntactically safe alias.
 */
export type AntigravityConversationTranscriptAuthorization =
  | Readonly<{ status: 'authorized'; transcriptPath: string }>
  | Readonly<{ status: 'unavailable' }>
  | Readonly<{ status: 'unauthorized' }>;

export async function authorizeAntigravityConversationTranscriptFile(params: Readonly<{
  brainDir: string;
  conversationId: string;
}>): Promise<AntigravityConversationTranscriptAuthorization> {
  if (!isSafeAntigravityConversationId(params.conversationId)) {
    return { status: 'unauthorized' };
  }
  const canonicalBrainDir = await realpath(params.brainDir).catch(() => resolve(params.brainDir));
  const pathSegments = [
    params.conversationId,
    '.system_generated',
    'logs',
    'transcript_full.jsonl',
  ] as const;
  let currentPath = canonicalBrainDir;
  for (const [index, segment] of pathSegments.entries()) {
    currentPath = join(currentPath, segment);
    const entry = await lstat(currentPath).catch(() => null);
    const isTranscript = index === pathSegments.length - 1;
    if (!entry) return { status: 'unavailable' };
    if (isTranscript ? !entry.isFile() : !entry.isDirectory()) {
      return { status: 'unauthorized' };
    }
  }
  const physicalTranscriptPath = await realpath(currentPath).catch(() => null);
  if (!physicalTranscriptPath) return { status: 'unavailable' };
  return isCanonicalAbsolutePathInsideRoot(canonicalBrainDir, physicalTranscriptPath)
    ? { status: 'authorized', transcriptPath: physicalTranscriptPath }
    : { status: 'unauthorized' };
}

export type AntigravityConversationCandidate = Readonly<{
  conversationId: string;
  transcriptPath: string;
  sourceRevision: string;
  updatedAtMs: number;
  title?: string;
}>;

const CONVERSATION_TITLE_MAX_CHARS = 120;

/**
 * The classified user step already carries the user-authored request body: the
 * mapper owns stripping Antigravity's prompt scaffolding, so the title only has
 * to normalize whitespace and bound the length.
 */
function formatAntigravityConversationTitle(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return normalized.length <= CONVERSATION_TITLE_MAX_CHARS
    ? normalized
    : `${normalized.slice(0, CONVERSATION_TITLE_MAX_CHARS - 3).trimEnd()}...`;
}

async function readAntigravityConversationTitle(params: Readonly<{
  transcriptPath: string;
  fileSystem?: JsonlScannerFileSystem;
}>): Promise<string | null> {
  const record = await readAntigravityTranscriptHeadRecord({
    path: params.transcriptPath,
    ...(params.fileSystem ? { fileSystem: params.fileSystem } : {}),
  });
  if (!record) return null;
  const [step] = mapAntigravityTranscriptRecordToSteps(record);
  return step?.kind === 'user_message' ? formatAntigravityConversationTitle(step.text) : null;
}

export class AntigravityCandidateSourceChangedError extends Error {
  readonly name = 'AntigravityCandidateSourceChangedError';
}

async function resolveAntigravityCandidateSourceGeneration(brainDir: string): Promise<string | null> {
  try {
    const root = await stat(brainDir, { bigint: true });
    if (!root.isDirectory()) return null;
    return [
      root.dev,
      root.ino,
      root.birthtimeNs,
      root.mtimeNs,
      root.ctimeNs,
    ].join(':');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function resolveAntigravityConversationCandidate(params: Readonly<{
  brainDir: string;
  conversationId: string;
  fileSystem?: JsonlScannerFileSystem;
}>): Promise<AntigravityConversationCandidate | null> {
  const authorization = await authorizeAntigravityConversationTranscriptFile(params);
  if (authorization.status !== 'authorized') return null;
  const transcriptPath = authorization.transcriptPath;
  const snapshot = await snapshotAntigravityTranscriptSource(transcriptPath);
  if (!snapshot) return null;
  const title = await readAntigravityConversationTitle({
    transcriptPath,
    ...(params.fileSystem ? { fileSystem: params.fileSystem } : {}),
  });
  return {
    conversationId: params.conversationId,
    transcriptPath,
    sourceRevision: snapshot.sourceRevision,
    updatedAtMs: snapshot.mtimeMs,
    ...(title ? { title } : {}),
  };
}

export async function pageAntigravityConversationCandidates(params: Readonly<{
  brainDir: string;
  afterDirectoryEntryOffset?: number | null;
  expectedSourceGeneration?: string | null;
  maxItems: number;
  signal?: AbortSignal;
  fileSystem?: JsonlScannerFileSystem;
}>): Promise<Readonly<{
  candidates: readonly (AntigravityConversationCandidate & Readonly<{
    directoryEntryOffset: number;
  }>)[];
  nextDirectoryEntryOffset: number | null;
  scanned: number;
  sourceGeneration: string | null;
}>> {
  const limit = Math.max(1, Math.trunc(params.maxItems));
  const afterDirectoryEntryOffset = Math.max(
    0,
    Math.trunc(params.afterDirectoryEntryOffset ?? 0),
  );
  const sourceGeneration = await resolveAntigravityCandidateSourceGeneration(params.brainDir);
  if (
    params.expectedSourceGeneration
    && params.expectedSourceGeneration !== sourceGeneration
  ) {
    throw new AntigravityCandidateSourceChangedError(
      'Antigravity candidate source changed while building its exact index.',
    );
  }
  const selected: Readonly<{ conversationId: string; directoryEntryOffset: number }>[] = [];
  let directoryEntryOffset = 0;
  let scanned = 0;
  let directory;
  try {
    directory = await opendir(params.brainDir);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {
        candidates: [],
        nextDirectoryEntryOffset: null,
        scanned: afterDirectoryEntryOffset,
        sourceGeneration: null,
      };
    }
    throw error;
  }
  for await (const entry of directory) {
    params.signal?.throwIfAborted();
    directoryEntryOffset += 1;
    if (directoryEntryOffset <= afterDirectoryEntryOffset) continue;
    scanned += 1;
    if (
      !entry.isDirectory()
      || !isSafeAntigravityConversationId(entry.name)
    ) {
      if (scanned >= limit) break;
      continue;
    }
    selected.push({
      conversationId: entry.name,
      directoryEntryOffset,
    });
    if (scanned >= limit) break;
  }

  const candidates: (AntigravityConversationCandidate & Readonly<{
    directoryEntryOffset: number;
  }>)[] = [];
  for (const selectedEntry of selected) {
    params.signal?.throwIfAborted();
    const candidate = await resolveAntigravityConversationCandidate({
      brainDir: params.brainDir,
      conversationId: selectedEntry.conversationId,
      ...(params.fileSystem ? { fileSystem: params.fileSystem } : {}),
    });
    if (candidate) {
      candidates.push({
        ...candidate,
        directoryEntryOffset: selectedEntry.directoryEntryOffset,
      });
    }
  }
  const finalSourceGeneration = await resolveAntigravityCandidateSourceGeneration(params.brainDir);
  if (finalSourceGeneration !== sourceGeneration) {
    throw new AntigravityCandidateSourceChangedError(
      'Antigravity candidate source changed during the bounded scan chunk.',
    );
  }
  const cumulativeScanned = afterDirectoryEntryOffset + scanned;
  return {
    candidates,
    nextDirectoryEntryOffset: scanned >= limit ? cumulativeScanned : null,
    scanned: cumulativeScanned,
    sourceGeneration,
  };
}

export async function snapshotAntigravityConversations(brainDir: string): Promise<ReadonlySet<string>> {
  const conversations = new Set<string>();
  let entries: string[];
  try {
    entries = await readdir(brainDir);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return conversations;
    throw error;
  }
  await Promise.all(entries.map(async (entry) => {
    const transcriptPath = join(brainDir, entry, '.system_generated', 'logs', 'transcript_full.jsonl');
    try {
      const transcriptStat = await stat(transcriptPath);
      if (transcriptStat.isFile()) conversations.add(entry);
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }));
  return conversations;
}

export function discoverNewAntigravityConversationId(
  before: ReadonlySet<string>,
  after: ReadonlySet<string>,
): AntigravityConversationDiscovery {
  const candidates = [...after].filter((conversationId) => !before.has(conversationId)).sort();
  if (candidates.length === 1) return { status: 'found', conversationId: candidates[0] ?? '' };
  if (candidates.length === 0) return { status: 'not_found' };
  return { status: 'ambiguous', candidates };
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function readAntigravityConversationAffinity(metadata: Readonly<Record<string, unknown>>): string | null {
  const antigravity = readRecord(metadata.antigravity);
  const cliPrint = readRecord(antigravity?.cliPrint);
  return readNonEmptyString(cliPrint?.agyConversationId)
    ?? readNonEmptyString(antigravity?.agyConversationId)
    ?? null;
}

export function writeAntigravityConversationAffinity(
  metadata: Readonly<Record<string, unknown>>,
  conversationId: string,
): Readonly<Record<string, unknown>> {
  const antigravity = readRecord(metadata.antigravity) ?? {};
  return {
    ...metadata,
    antigravity: {
      ...antigravity,
      cliPrint: {
        ...(readRecord(antigravity.cliPrint) ?? {}),
        agyConversationId: conversationId,
      },
    },
  };
}
