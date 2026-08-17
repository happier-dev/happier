import { MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';

import type { AzureDevOpsOrigin } from './types.js';

const BASE64_URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Unpadded base64url of the UTF-8 bytes. Deterministic and transport-safe. */
export function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += BASE64_URL_ALPHABET[first >> 2];
    encoded += BASE64_URL_ALPHABET[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second === undefined) break;
    encoded += BASE64_URL_ALPHABET[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    if (third === undefined) break;
    encoded += BASE64_URL_ALPHABET[third & 0x3f];
  }
  return encoded;
}

export function isAzureGuid(value: unknown): value is string {
  return typeof value === 'string' && GUID_PATTERN.test(value.trim());
}

/**
 * `azure-devops:<base64url(normalized configured base)>:<repository GUID>`.
 *
 * The configured account is deliberately not a component: two configured accounts pointed at
 * the same base observe the same repository entry. Names never appear, because an Azure name
 * keeps resolving after a rename and a stale name-keyed identity never announces itself.
 *
 * The scope is a structural key with its own published ceiling, and base64url inflates a
 * configured base by a third — a Server collection base is long enough to reach it where a
 * `dev.azure.com` one never does. An over-bound scope would be rejected at the target
 * ATOMICALLY, discarding every sibling row on the same page, so a row that cannot express its
 * own identity within the published bound is omitted and counted here instead. Shortening is
 * not available: the scope is read back to route an authoritative `get`, so a cut one keys a
 * different repository.
 */
export function buildAzureCollisionScope(input: Readonly<{
  origin: AzureDevOpsOrigin;
  repositoryId: string;
}>): string | null {
  if (!isAzureGuid(input.repositoryId)) return null;
  const scope = `azure-devops:${encodeBase64Url(input.origin.baseUrl)}:${input.repositoryId.trim().toLowerCase()}`;
  return new TextEncoder().encode(scope).byteLength <= MAX_TRIAGE_COLLISION_SCOPE_UTF8_BYTES_V1
    ? scope
    : null;
}

/** `String(pullRequestId)` — the same integer the provider shows as the number. */
export function buildAzureEntryId(rawPullRequestId: unknown): string | null {
  if (typeof rawPullRequestId !== 'number') return null;
  if (!Number.isSafeInteger(rawPullRequestId) || rawPullRequestId <= 0) return null;
  return String(rawPullRequestId);
}
