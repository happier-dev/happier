import { readFile, stat } from 'node:fs/promises';

export type AntigravityTranscriptJsonRecord = Readonly<Record<string, unknown>>;

export type AntigravityTranscriptTailCursor = Readonly<{
  offset: number;
  seenIds: readonly string[];
  seenFingerprints?: readonly string[];
  fileIdentity?: string;
  tailFingerprint?: string;
}>;

export type AntigravityTranscriptTailResult = Readonly<{
  records: readonly AntigravityTranscriptJsonRecord[];
  cursor: AntigravityTranscriptTailCursor;
  missing?: boolean;
}>;

function isRecord(value: unknown): value is AntigravityTranscriptJsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stableRecordId(record: AntigravityTranscriptJsonRecord): string | null {
  for (const key of ['id', 'stepId', 'step_id', 'uuid']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function stableRecordFingerprint(record: AntigravityTranscriptJsonRecord): string {
  return JSON.stringify(record);
}

function readFileIdentity(stats: Awaited<ReturnType<typeof stat>>): string {
  return `${stats.dev}:${stats.ino}`;
}

const TAIL_FINGERPRINT_CHARS = 4096;

function readTailFingerprint(content: string): string {
  return content.slice(Math.max(0, content.length - TAIL_FINGERPRINT_CHARS));
}

function shouldResetTailOffset(params: Readonly<{
  content: string;
  previousOffset: number;
  cursor?: AntigravityTranscriptTailCursor;
  fileIdentity: string;
}>): boolean {
  if (params.content.length < params.previousOffset) return true;
  if (!params.cursor || params.previousOffset === 0) return false;
  if (params.cursor.fileIdentity && params.cursor.fileIdentity !== params.fileIdentity) return true;
  const previousTail = params.cursor.tailFingerprint;
  if (!previousTail) return false;
  const start = Math.max(0, params.previousOffset - previousTail.length);
  return params.content.slice(start, params.previousOffset) !== previousTail;
}

export function parseAntigravityTranscriptJsonl(
  input: string,
  options: Readonly<{ allowPartialLastLine?: boolean }> = {},
): readonly AntigravityTranscriptJsonRecord[] {
  const lines = input.split('\n');
  const records: AntigravityTranscriptJsonRecord[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line?.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) {
        throw new Error('line is not a JSON object');
      }
      records.push(parsed);
    } catch (error) {
      const isLastLine = index === lines.length - 1;
      if (options.allowPartialLastLine && isLastLine && !input.endsWith('\n')) continue;
      throw new Error(`Malformed Antigravity transcript JSONL at line ${index + 1}: ${error instanceof Error ? error.message : 'parse failed'}`);
    }
  }
  return records;
}

export async function readAntigravityTranscriptTail(params: Readonly<{
  path: string;
  cursor?: AntigravityTranscriptTailCursor;
}>): Promise<AntigravityTranscriptTailResult> {
  let content: string;
  let fileIdentity: string;
  try {
    fileIdentity = readFileIdentity(await stat(params.path));
    content = await readFile(params.path, 'utf8');
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {
        records: [],
        cursor: params.cursor ?? { offset: 0, seenIds: [], seenFingerprints: [] },
        missing: true,
      };
    }
    throw error;
  }

  const previousOffset = params.cursor?.offset ?? 0;
  const offset = shouldResetTailOffset({
    content,
    previousOffset,
    cursor: params.cursor,
    fileIdentity,
  }) ? 0 : previousOffset;
  const seen = new Set(params.cursor?.seenIds ?? []);
  const seenFingerprints = new Set(params.cursor?.seenFingerprints ?? []);
  const rawRecords = parseAntigravityTranscriptJsonl(content.slice(offset), { allowPartialLastLine: true });
  const records: AntigravityTranscriptJsonRecord[] = [];
  for (const record of rawRecords) {
    const id = stableRecordId(record);
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
    } else {
      const fingerprint = stableRecordFingerprint(record);
      if (seenFingerprints.has(fingerprint)) continue;
      seenFingerprints.add(fingerprint);
    }
    records.push(record);
  }
  return {
    records,
    cursor: {
      offset: content.length,
      seenIds: [...seen].sort(),
      seenFingerprints: [...seenFingerprints].sort(),
      fileIdentity,
      tailFingerprint: readTailFingerprint(content),
    },
  };
}
