import { fetchSessionById } from '@/sessionControl/sessionsHttp';

export async function fetchSessionDataEncryptionKey(params: Readonly<{
  token: string;
  sessionId: string;
}>): Promise<string | null> {
  const session = await fetchSessionById({ token: params.token, sessionId: params.sessionId });
  if (!session) return null;
  const encrypted = (session as any).dataEncryptionKey;
  return typeof encrypted === 'string' && encrypted.trim().length > 0 ? encrypted.trim() : null;
}
