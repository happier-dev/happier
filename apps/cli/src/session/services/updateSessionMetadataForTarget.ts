import type { StoredCredentials } from '@/persistence';
import {
  assertSessionMetadataMutationCurrentness,
  updateSessionMetadataWithRetry,
  type SessionMetadataMutationCurrentness,
} from '@/session/metadata/updateSessionMetadataWithRetry';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';

export type UpdateSessionMetadataForTargetResult =
  | Readonly<{ ok: true; sessionId: string; metadata: Record<string, unknown>; version: number }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'session_lookup_timeout' | 'encryption_material_unavailable' | 'unsupported' | 'conflict' | 'forbidden' | 'unknown_error'; candidates?: string[] }>;

export async function updateSessionMetadataForTarget(params: Readonly<{
  credentials: StoredCredentials;
  idOrPrefix: string;
  updater: Parameters<typeof updateSessionMetadataWithRetry>[0]['updater'];
  currentness?: SessionMetadataMutationCurrentness;
  maxAttempts?: number;
}>): Promise<UpdateSessionMetadataForTargetResult> {
  assertSessionMetadataMutationCurrentness(params.currentness);
  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
    ...(params.currentness?.signal ? { signal: params.currentness.signal } : {}),
  });
  assertSessionMetadataMutationCurrentness(params.currentness);
  if (!sessionTarget.ok) {
    return {
      ok: false,
      code: sessionTarget.code,
      ...(sessionTarget.candidates ? { candidates: sessionTarget.candidates } : {}),
    };
  }

  const result = await updateSessionMetadataWithRetry({
    token: params.credentials.token,
    credentials: params.credentials,
    sessionId: sessionTarget.sessionId,
    rawSession: sessionTarget.rawSession,
    accountEncryptionCurrentness: sessionTarget.accountEncryptionCurrentness,
    updater: params.updater,
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
