import type { StoredCredentials } from '@/persistence';
import {
  assertSessionMetadataMutationCurrentness,
  updateSessionMetadataWithRetry,
  type SessionMetadataMutationCurrentness,
} from '@/session/metadata/updateSessionMetadataWithRetry';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';

export type UpdateSessionMetadataForTargetResult =
  | Readonly<{ ok: true; sessionId: string; metadata: Record<string, unknown>; version: number }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'encryption_material_unavailable' | 'account_encryption_currentness_unavailable' | 'metadata_privacy_upgrade_required' | 'session_publisher_authority_lost' | 'unsupported' | 'conflict' | 'forbidden' | 'unknown_error'; candidates?: string[] }>;

export async function updateSessionMetadataForTarget(params: Readonly<{
  credentials: StoredCredentials;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown;
  }>) => Readonly<Record<string, string>> | null;
  idOrPrefix: string;
  /** Qualified callers require this exact identity, never a prefix/tag fallback. */
  expectedSessionId?: string;
  updater: Parameters<typeof updateSessionMetadataWithRetry>[0]['updater'];
  expectedMetadataRevision?: number;
  currentness?: SessionMetadataMutationCurrentness;
  maxAttempts?: number;
  serverFeaturesSnapshot?: CliServerFeaturesSnapshot;
}>): Promise<UpdateSessionMetadataForTargetResult> {
  assertSessionMetadataMutationCurrentness(params.currentness);
  const sessionTarget = await resolveSessionTransportContext({
    reason: 'waitForMetadataUpdate',
    credentials: params.credentials,
    ...(params.resolveAuthorizationHeaders
      ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
      : {}),
    idOrPrefix: params.idOrPrefix,
    ...(params.currentness?.signal ? { signal: params.currentness.signal } : {}),
    ...(params.serverFeaturesSnapshot ? { serverFeaturesSnapshot: params.serverFeaturesSnapshot } : {}),
  });
  assertSessionMetadataMutationCurrentness(params.currentness);
  if (!sessionTarget.ok) {
    return {
      ok: false,
      code: sessionTarget.code,
      ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
    };
  }

  if (params.expectedSessionId !== undefined && (
    sessionTarget.sessionId !== params.expectedSessionId
    || sessionTarget.rawSession.id !== params.expectedSessionId
  )) {
    return { ok: false, code: 'session_not_found' };
  }

  const result = await updateSessionMetadataWithRetry({
    token: params.credentials.token,
    credentials: params.credentials,
    ...(params.resolveAuthorizationHeaders
      ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
      : {}),
    sessionId: sessionTarget.sessionId,
    rawSession: sessionTarget.rawSession,
    accountEncryptionCurrentness: sessionTarget.accountEncryptionCurrentness,
    updater: params.updater,
    expectedMetadataRevision: params.expectedMetadataRevision,
    currentness: params.currentness,
    ...(typeof params.maxAttempts === 'number' ? { maxAttempts: params.maxAttempts } : {}),
  });

  return {
    ok: true,
    sessionId: sessionTarget.sessionId,
    metadata: result.metadata,
    version: result.version,
  };
}
