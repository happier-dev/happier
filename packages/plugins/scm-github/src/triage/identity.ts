import {
  MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1,
  MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1,
} from '@happier-dev/triage-protocol/v1';

import type {
  GithubTriageEntryLocalRefV1,
  GithubTriageKindIdV1,
} from './types.js';

/**
 * The one GitHub identity builder. Scan, get, detail and every mutation construct
 * `{ kindId, collisionScope, entryId }` here and nowhere else, so a split identity
 * cannot appear between two read paths.
 */

const GITHUB_COLLISION_SCOPE_PREFIX = 'github:';

const POSITIVE_DECIMAL_PATTERN = /^[1-9][0-9]*$/u;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function readPositiveDecimal(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 1) return null;
    return String(value);
  }
  if (typeof value !== 'string') return null;
  const candidate = value.trim();
  return POSITIVE_DECIMAL_PATTERN.test(candidate) ? candidate : null;
}

export function buildGithubCollisionScope(repositoryId: unknown): string | null {
  const id = readPositiveDecimal(repositoryId);
  if (id === null) return null;
  const scope = `${GITHUB_COLLISION_SCOPE_PREFIX}${id}`;
  // The collision scope is a structural key with its own published bound, not a
  // provider identifier: a scope this source cannot emit within it would be rejected
  // at the target, so the row is skipped here instead.
  return utf8ByteLength(scope) <= MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1 ? scope : null;
}

/** Reads the immutable repository id from this source's own collision scope. */
export function readGithubRepositoryIdFromCollisionScope(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith(GITHUB_COLLISION_SCOPE_PREFIX)) return null;
  const repositoryId = readPositiveDecimal(value.slice(GITHUB_COLLISION_SCOPE_PREFIX.length));
  return repositoryId !== null && buildGithubCollisionScope(repositoryId) === value
    ? repositoryId
    : null;
}

/**
 * Builds one entry ref, or `null` when the raw entity cannot prove its identity. A row
 * without a usable repository id or item number is skipped and counted as an omission;
 * it never receives a fabricated or empty key.
 */
export function buildGithubEntryLocalRef(input: Readonly<{
  kindId: GithubTriageKindIdV1;
  repositoryId: unknown;
  nativeItemId: unknown;
}>): GithubTriageEntryLocalRefV1 | null {
  const collisionScope = buildGithubCollisionScope(input.repositoryId);
  if (collisionScope === null) return null;
  const entryId = readPositiveDecimal(input.nativeItemId);
  if (entryId === null) return null;
  if (utf8ByteLength(entryId) > MAX_TRIAGE_IDENTIFIER_UTF8_BYTES_V1) return null;
  return Object.freeze({ kindId: input.kindId, collisionScope, entryId });
}
