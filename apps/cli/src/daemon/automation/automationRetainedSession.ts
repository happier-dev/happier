import type { AutomationTemplateRetainedSessionV1 } from '@happier-dev/protocol';
import type { StoredCredentials } from '@/persistence';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';
import { resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode } from '@/session/transport/encryption/sessionEncryptionContext';

/** Session transport owns authorization and key envelopes; historical custody never selects Account mode. */
export async function resolveAutomationTemplateRetainedSession(params: Readonly<{
  credentials: StoredCredentials; sessionId: string; signal?: AbortSignal;
}>): Promise<AutomationTemplateRetainedSessionV1 | null> {
  const session = await fetchSessionById({ token: params.credentials.token, sessionId: params.sessionId,
    ...(params.signal ? { signal: params.signal } : {}) });
  params.signal?.throwIfAborted();
  if (!session || session.id !== params.sessionId) return null;
  const encryptionMode = resolveSessionStoredContentEncryptionMode(session);
  const encryption = params.credentials.encryption;
  const ctx = encryptionMode === 'e2ee' ? resolveSessionEncryptionContextFromCredentials(params.credentials, session) : null;
  return { sessionId: session.id, encryptionMode,
    ...(ctx && encryption ? { material: encryption.type === 'legacy'
      ? { type: 'legacy' as const, secret: encryption.secret }
      : { type: 'dataKey' as const, machineKey: encryption.machineKey } } : {}) };
}
