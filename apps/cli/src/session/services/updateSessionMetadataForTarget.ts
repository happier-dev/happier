import type { Credentials } from '@/persistence';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';

import { resolveSessionTransportContext } from './resolveSessionTransportContext';

export async function updateSessionMetadataForTarget(params: Readonly<{
  credentials: Credentials;
  idOrPrefix: string;
  updater: Parameters<typeof updateSessionMetadataWithRetry>[0]['updater'];
}>): Promise<
  | Readonly<{ ok: true; sessionId: string; metadata: Record<string, unknown>; version: number }>
  | Readonly<{ ok: false; code: 'session_not_found' | 'session_id_ambiguous' | 'unsupported'; candidates?: string[] }>
> {
  const sessionTarget = await resolveSessionTransportContext({
    credentials: params.credentials,
    idOrPrefix: params.idOrPrefix,
  });
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
    updater: params.updater,
  });

  return {
    ok: true,
    sessionId: sessionTarget.sessionId,
    metadata: result.metadata,
    version: result.version,
  };
}
