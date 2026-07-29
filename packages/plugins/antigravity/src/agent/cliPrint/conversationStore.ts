import { opendir, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { snapshotAntigravityTranscriptSource } from './transcript/jsonl.js';

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

export type AntigravityConversationCandidate = Readonly<{
  conversationId: string;
  transcriptPath: string;
  sourceRevision: string;
  updatedAtMs: number;
}>;

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
}>): Promise<AntigravityConversationCandidate | null> {
  if (!isSafeAntigravityConversationId(params.conversationId)) return null;
  const transcriptPath = resolveAntigravityTranscriptFullPath(params.brainDir, params.conversationId);
  const snapshot = await snapshotAntigravityTranscriptSource(transcriptPath);
  return snapshot
    ? {
        conversationId: params.conversationId,
        transcriptPath,
        sourceRevision: snapshot.sourceRevision,
        updatedAtMs: snapshot.mtimeMs,
      }
    : null;
}

export async function pageAntigravityConversationCandidates(params: Readonly<{
  brainDir: string;
  afterDirectoryEntryOffset?: number | null;
  expectedSourceGeneration?: string | null;
  maxItems: number;
  signal?: AbortSignal;
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
