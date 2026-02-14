import axios from 'axios';

import { configuration } from '@/configuration';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';

export async function fetchSessionDataEncryptionKey(params: Readonly<{
  token: string;
  sessionId: string;
}>): Promise<string | null> {
  const serverUrl = resolveLoopbackHttpUrl(configuration.serverUrl).replace(/\/+$/, '');
  const response = await axios.get(`${serverUrl}/v2/sessions/${params.sessionId}`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 10_000,
    validateStatus: () => true,
  });

  if (response.status === 404) {
    return null;
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`Unauthorized (${response.status})`);
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v2/sessions/:id: ${response.status}`);
  }

  const session = (response.data as any)?.session;
  if (!session || typeof session !== 'object') {
    throw new Error('Unexpected /v2/sessions response shape');
  }

  const encrypted = (session as any).dataEncryptionKey;
  return typeof encrypted === 'string' && encrypted.trim().length > 0 ? encrypted.trim() : null;
}

