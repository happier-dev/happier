import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

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

async function appendJsonlLines(path: string, current: string | null, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  const separator = current && !current.endsWith('\n') ? '\n' : '';
  await appendFile(path, `${separator}${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
}

export async function reconcileCodexSharedJsonlState(params: Readonly<{
  previousCodexHome?: string | null;
  sourceCodexHome: string;
}>): Promise<void> {
  if (!params.previousCodexHome) return;
  for (const file of CODEX_JSONL_STATE_FILES) {
    const incoming = await readOptionalFile(join(params.previousCodexHome, file.name));
    if (incoming === null) continue;
    const destinationPath = join(params.sourceCodexHome, file.name);
    const current = await readOptionalFile(destinationPath);
    const missing = file.kind === 'history'
      ? resolveMissingHistoryLines(current, incoming)
      : resolveMissingSessionIndexLines(current, incoming);
    await appendJsonlLines(destinationPath, current, missing);
  }
}
