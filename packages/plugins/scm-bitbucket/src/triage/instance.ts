import { MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1 } from '@happier-dev/triage-protocol/v1';

import { readBitbucketBracedUuid } from './identity.js';

/**
 * The Bitbucket Cloud configured-instance record.
 *
 * A configured instance is exactly one authorized account observing one workspace, so the only
 * source-native routing fact this token carries is that workspace's immutable UUID. It holds no
 * credential, no origin (the Connected Account and the fixed-origin host-access declaration own
 * that), no account ref, no filesystem path, and no target timestamp.
 *
 * The workspace slug and display name are deliberately absent: both are mutable locator facts that
 * a Settings refresh re-reads, and duplicating them here would create a second, staler carrier.
 */
export type BitbucketConfigurationRecord = Readonly<{
  v: 1;
  workspaceUuid: string;
}>;

export type BitbucketConfigurationEncodeResult =
  | Readonly<{ ok: true; token: string }>
  | Readonly<{ ok: false; reason: 'workspace-uuid-invalid' | 'token-too-large' }>;

/**
 * The strict versioned encoder this source owns. The target bounds, copies, and returns these bytes
 * without parsing them, so the source is the only place that can reject an invalid record.
 */
export function encodeBitbucketConfiguration(
  record: BitbucketConfigurationRecord,
): BitbucketConfigurationEncodeResult {
  if (record.v !== 1) return { ok: false, reason: 'workspace-uuid-invalid' };
  const workspaceUuid = readBitbucketBracedUuid(record.workspaceUuid);
  if (workspaceUuid === null) return { ok: false, reason: 'workspace-uuid-invalid' };

  const token = JSON.stringify({ v: 1, workspaceUuid });
  if (new TextEncoder().encode(token).byteLength > MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1) {
    return { ok: false, reason: 'token-too-large' };
  }
  return { ok: true, token };
}

/**
 * The strict versioned decoder. A token this source did not produce — a different version, a
 * different shape, an unbraced UUID, or oversize bytes — decodes to `null`, and every caller maps
 * that to `unsupportedContract` rather than guessing a workspace.
 */
export function decodeBitbucketConfiguration(
  configuration: Readonly<{ v: 1; token: string }>,
): BitbucketConfigurationRecord | null {
  if (configuration.v !== 1) return null;
  if (typeof configuration.token !== 'string' || configuration.token.length === 0) return null;
  if (
    new TextEncoder().encode(configuration.token).byteLength
    > MAX_TRIAGE_CONFIGURATION_TOKEN_UTF8_BYTES_V1
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(configuration.token);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) return null;
  const workspaceUuid = readBitbucketBracedUuid(record.workspaceUuid);
  if (workspaceUuid === null) return null;
  // Closed record: an unknown member means these are not this decoder's bytes.
  if (Object.keys(record).length !== 2) return null;

  return { v: 1, workspaceUuid };
}

/**
 * The source-native instance key is the workspace UUID **verbatim, braces included**.
 *
 * It re-encodes neither the declared purpose nor the account ref: the exact binding is already a
 * separate member of the target's matching tuple, so two accounts that both reach one workspace stay
 * two configured instances with the same local key.
 */
export function readBitbucketLocalInstanceKey(workspaceUuid: unknown): string | null {
  return readBitbucketBracedUuid(workspaceUuid);
}
