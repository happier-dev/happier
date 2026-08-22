import { createHash } from 'node:crypto';

import type { RawJSONLines } from './rawJsonLines.js';

export const CLAUDE_JSONL_LOCAL_ID_PREFIX = 'claude-jsonl:';

export type ClaudeJsonlProviderFactIdentityContext = Readonly<{
  fileRelPath?: string;
  lineStartOffsetBytes?: number;
}>;

function readIdentifier(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNonNegativeOffset(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0;
}

function buildSidechainFallbackScope(
  context: ClaudeJsonlProviderFactIdentityContext | undefined,
): string | null {
  const fileRelPath = readIdentifier(context?.fileRelPath);
  if (!fileRelPath) return null;
  // The fallback preserves source-file separation without disclosing the path through localId.
  const fingerprint = createHash('sha256')
    .update(fileRelPath, 'utf8')
    .digest('base64url')
    .slice(0, 16);
  return `sidechain-file-${fingerprint}-${readNonNegativeOffset(context?.lineStartOffsetBytes)}`;
}

export function buildClaudeJsonlProviderFactLocalIdFromParts(
  input: Readonly<{
    type: string;
    id: string;
    sidechainId?: string | null;
  }>,
): string | null {
  const type = readIdentifier(input.type);
  const id = readIdentifier(input.id);
  if (!type || !id) return null;
  const sidechainId = readIdentifier(input.sidechainId) ?? 'main';
  return `${CLAUDE_JSONL_LOCAL_ID_PREFIX}${sidechainId}:${type}:${id}`;
}

/**
 * Stable identity of one Claude JSONL fact. File offsets remain the paging
 * identity; this key is the cross-reader transcript idempotency identity.
 */
export function buildClaudeJsonlProviderFactLocalId(
  row: RawJSONLines,
  context?: ClaudeJsonlProviderFactIdentityContext,
): string | null {
  const record = row as Readonly<Record<string, unknown>>;
  const rawId = row.type === 'summary'
    ? readIdentifier(record.leafUuid)
    : readIdentifier(record.uuid);
  if (!rawId) return null;
  const explicitSidechainId = readIdentifier(record.sidechainId);
  const sidechainId = explicitSidechainId
    ?? (record.isSidechain === true ? buildSidechainFallbackScope(context) : null);
  return buildClaudeJsonlProviderFactLocalIdFromParts({
    type: row.type,
    id: rawId,
    sidechainId,
  });
}
