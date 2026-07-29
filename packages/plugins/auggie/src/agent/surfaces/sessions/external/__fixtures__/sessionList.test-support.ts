// Test support parser for the pinned public evidence fixture.
export type AuggieSessionCandidateV0_24_0 = Readonly<{
  sessionId: string;
  title?: string;
  createdAtMs?: number;
  updatedAtMs: number;
  exchangeCount?: number;
  workspaceRoot?: string;
}>;

export type ParsedAuggieSessionListV0_24_0 = Readonly<{
  candidates: readonly AuggieSessionCandidateV0_24_0[];
  invalidRecordCount: number;
}>;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readTrimmedString(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readTimestamp(record: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = readTrimmedString(record, key);
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function readNonNegativeInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Parses only the public `auggie session list --json` summary shape published
 * by Auggie 0.24.0. Prompt/request arrays are intentionally not retained.
 */
export function parseAuggieSessionListV0_24_0(raw: unknown): ParsedAuggieSessionListV0_24_0 {
  if (!Array.isArray(raw)) {
    return { candidates: [], invalidRecordCount: 1 };
  }

  const candidates: AuggieSessionCandidateV0_24_0[] = [];
  let invalidRecordCount = 0;

  for (const value of raw) {
    const record = asRecord(value);
    const sessionId = record ? readTrimmedString(record, 'sessionId') : null;
    const updatedAtMs = record ? readTimestamp(record, 'modified') : null;
    if (!record || !sessionId || updatedAtMs === null) {
      invalidRecordCount += 1;
      continue;
    }

    const title = readTrimmedString(record, 'name');
    const createdAtMs = readTimestamp(record, 'created');
    const exchangeCount = readNonNegativeInteger(record, 'exchangeCount');
    const workspaceRoot = readTrimmedString(record, 'workspaceRoot');
    candidates.push({
      sessionId,
      ...(title ? { title } : {}),
      ...(createdAtMs === null ? {} : { createdAtMs }),
      updatedAtMs,
      ...(exchangeCount === null ? {} : { exchangeCount }),
      ...(workspaceRoot ? { workspaceRoot } : {}),
    });
  }

  return { candidates, invalidRecordCount };
}
