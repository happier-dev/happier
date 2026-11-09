import type { AgentConnectedAccountSharedStateFileMergeV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import { parseCodexRolloutFilename, resolveCodexLogicalRolloutPath } from '../../../../rollout/discovery/indexData.js';

type CodexJsonlStateFile = Readonly<{
  name: 'history.jsonl' | 'session_index.jsonl';
  kind: 'history' | 'session_index';
}>;

const CODEX_JSONL_STATE_FILES = Object.freeze([
  { name: 'history.jsonl', kind: 'history' },
  { name: 'session_index.jsonl', kind: 'session_index' },
] satisfies readonly CodexJsonlStateFile[]);

type SessionIndexRecord = Readonly<{
  id: string;
  updatedAt: string;
}>;

function nonEmptyLines(content: string | null): string[] {
  return (content ?? '').split(/\r?\n/u).filter((line) => line.length > 0);
}

function parseSessionIndexRecord(line: string): SessionIndexRecord | null {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object') return null;
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || typeof record.updated_at !== 'string') return null;
    return { id: record.id, updatedAt: record.updated_at };
  } catch {
    return null;
  }
}

function resolveMissingHistoryLines(current: string | null, incoming: string): string[] {
  const seen = new Set(nonEmptyLines(current));
  return nonEmptyLines(incoming).filter((line) => {
    if (seen.has(line)) return false;
    seen.add(line);
    return true;
  });
}

function resolveMissingSessionIndexLines(current: string | null, incoming: string): string[] {
  const seen = new Set(nonEmptyLines(current));
  const latestBySessionId = new Map<string, string>();
  for (const line of seen) {
    const record = parseSessionIndexRecord(line);
    if (!record) continue;
    const latest = latestBySessionId.get(record.id);
    if (!latest || record.updatedAt > latest) latestBySessionId.set(record.id, record.updatedAt);
  }
  const missing: string[] = [];
  for (const line of nonEmptyLines(incoming)) {
    if (seen.has(line)) continue;
    seen.add(line);
    const record = parseSessionIndexRecord(line);
    if (record) {
      const latest = latestBySessionId.get(record.id);
      if (latest && record.updatedAt <= latest) continue;
      latestBySessionId.set(record.id, record.updatedAt);
    }
    missing.push(line);
  }
  return missing;
}

export const reconcileCodexSharedJsonlState: AgentConnectedAccountSharedStateFileMergeV1 = (input) => {
  if ((input.entryPath.startsWith('sessions/') || input.entryPath.startsWith('archived_sessions/'))
    && input.entryPath === resolveCodexLogicalRolloutPath(input.entryPath)
    && parseCodexRolloutFilename(input.entryPath)) {
    const current = input.currentContents ?? '';
    const incoming = input.incomingContents;
    // Adopt an append-only continuation, never interleave divergent conversations or
    // publish a partially written JSONL record. Other conflicts retain the importer policy.
    if ((current && !current.endsWith('\n')) || !incoming.endsWith('\n')) return null;
    if (incoming.startsWith(current)) return { appendText: incoming.slice(current.length) };
    if (current.startsWith(incoming)) return { appendText: '' };
    return null;
  }
  const file = CODEX_JSONL_STATE_FILES.find(candidate => candidate.name === input.entryPath);
  if (!file) return null;
  const current = input.currentContents ?? '';
  const incoming = input.incomingContents;
  // Empty text, exact text or an adopted complete-line prefix proves a no-op without
  // parsing. File metadata alone cannot prove this for rewrites or truncation.
  if (!incoming || current === incoming || (incoming.endsWith('\n') && current.startsWith(incoming))) return { appendText: '' };
  const missing = file.kind === 'history'
    ? resolveMissingHistoryLines(input.currentContents, input.incomingContents)
    : resolveMissingSessionIndexLines(input.currentContents, input.incomingContents);
  const separator = input.currentContents && !input.currentContents.endsWith('\n') ? '\n' : '';
  return { appendText: missing.length === 0 ? '' : `${separator}${missing.join('\n')}\n` };
};
