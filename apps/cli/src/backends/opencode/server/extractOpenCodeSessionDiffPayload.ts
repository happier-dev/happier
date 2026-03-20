import { extractOpenCodeFileDiff, type OpenCodeFileDiff } from '../utils/extractOpenCodeFileDiff';

type UnknownRecord = Record<string, unknown>;

export type OpenCodeSessionDiffPayload = Readonly<{
  unifiedDiffs: readonly string[];
  textDiffs: readonly OpenCodeFileDiff[];
}>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function readDiffText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractUnifiedDiff(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  return (
    readDiffText(record.unifiedDiff)
    ?? readDiffText(record.unified_diff)
    ?? readDiffText(record.diff)
    ?? readDiffText(record.patch)
  );
}

export function extractOpenCodeSessionDiffPayload(raw: unknown): OpenCodeSessionDiffPayload {
  const rows = Array.isArray(raw) ? raw : [];
  const unifiedDiffs: string[] = [];
  const textDiffs: OpenCodeFileDiff[] = [];

  for (const row of rows) {
    const unifiedDiff = extractUnifiedDiff(row);
    if (unifiedDiff) {
      unifiedDiffs.push(unifiedDiff);
      continue;
    }

    const fileDiff = extractOpenCodeFileDiff(row);
    if (fileDiff) {
      textDiffs.push(fileDiff);
    }
  }

  return { unifiedDiffs, textDiffs };
}
