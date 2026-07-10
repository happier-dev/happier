import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
