import axios from 'axios';

import { configuration } from '@/configuration';
import { resolveLoopbackHttpUrl } from '@/api/client/loopbackUrl';

type RawTranscriptRow = Readonly<{
  seq?: unknown;
  createdAt?: unknown;
  content?: unknown;
}>;

export async function fetchEncryptedTranscriptMessages(params: Readonly<{
  token: string;
  sessionId: string;
  limit: number;
  beforeSeq?: number;
}>): Promise<RawTranscriptRow[]> {
  const serverUrl = resolveLoopbackHttpUrl(configuration.apiServerUrl).replace(/\/+$/, '');
  const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    params: {
      limit: params.limit,
      ...(typeof params.beforeSeq === 'number' && Number.isFinite(params.beforeSeq) ? { beforeSeq: Math.max(0, Math.floor(params.beforeSeq)) } : {}),
    },
    timeout: 10_000,
    validateStatus: () => true,
  });

  if (response.status === 401 || response.status === 403) {
    throw new Error(`Unauthorized (${response.status})`);
  }
  if (response.status !== 200) {
    throw new Error(`Unexpected status from /v1/sessions/:id/messages: ${response.status}`);
  }

  const raw = (response.data as any)?.messages;
  if (!Array.isArray(raw)) return [];
  return raw as RawTranscriptRow[];
}
