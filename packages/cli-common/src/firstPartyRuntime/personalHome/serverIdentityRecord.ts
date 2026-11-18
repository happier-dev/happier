import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

import { SERVER_IDENTITY_ID_PATTERN } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';

/**
 * A Stack shared-database consumer (a QA stack on its source stack's database) is a distinct
 * server that keeps its own Home identity in the record at `resolveServerIdentityRecordPath`
 * instead of in shared rows. The server, the Stack and the CLI decide this one way.
 */
export function isSharedDatabaseConsumer(env: Readonly<Record<string, string | undefined>>): boolean {
  return Boolean(env.HAPPIER_STACK_SHARED_DB_SOURCE_STACK?.trim());
}

/**
 * The one parser of the record the server writes: the identity, or null when blank. Content the
 * server could never have written is refused, so no reader trusts it as a Home identity.
 */
export function parseServerIdentityRecord(raw: string, sourceLabel: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (SERVER_IDENTITY_ID_PATTERN.test(value)) return value;
  throw new Error(`${sourceLabel} must match ${SERVER_IDENTITY_ID_PATTERN.source}`);
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

/** The recorded identity; null when the record is absent or blank. */
export async function readServerIdentityRecord(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  return parseServerIdentityRecord(raw, path);
}

/** Synchronous `readServerIdentityRecord` for synchronous readiness checks. */
export function readServerIdentityRecordSync(path: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  return parseServerIdentityRecord(raw, path);
}
