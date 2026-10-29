import axios from '@/api/client/credentialAxios';
import { SessionFollowSourceProjectionRequestV1Schema, SessionFollowSourceProjectionResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import type { SessionFollowSourceProjectionRequestV1, SessionFollowSourceProjectionResponseV1 } from '@happier-dev/protocol';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { HttpStatusError } from '@/api/client/httpStatusError';

export async function fetchSessionFollowSourceProjection(input: Readonly<{
  token: string;
  destinationSessionId: string;
  sourceSessionId: string;
  localInputId?: SessionFollowSourceProjectionRequestV1['localInputId'];
  relation?: SessionFollowSourceProjectionRequestV1['relation'];
  attachedAt?: number;
  readMode?: 'incremental';
  afterTranscriptSeq: number;
  observedTranscriptSeq: number;
  limit: number;
  signal: AbortSignal;
}>): Promise<SessionFollowSourceProjectionResponseV1 | null> {
  const body = SessionFollowSourceProjectionRequestV1Schema.parse({
    v: 1,
    sourceSessionId: input.sourceSessionId,
    ...(input.localInputId ? { localInputId: input.localInputId } : {}),
    ...(input.relation ? { relation: input.relation, attachedAt: input.attachedAt } : {}),
    ...(input.readMode ? { readMode: input.readMode } : {}),
    afterTranscriptSeq: input.afterTranscriptSeq,
    observedTranscriptSeq: input.observedTranscriptSeq,
    limit: input.limit,
  });
  const response = await axios.post(
    `${resolveServerHttpBaseUrl()}/v2/sessions/${encodeURIComponent(input.destinationSessionId)}/follows/source-projection`,
    body,
    {
      headers: { Authorization: `Bearer ${input.token}`, 'Content-Type': 'application/json' },
      signal: input.signal,
      timeout: 10_000,
      validateStatus: () => true,
    },
  );
  if (response.status === 404) return null;
  if (response.status !== 200) throw new HttpStatusError(response.status, 'Session Follow source projection unavailable');
  return SessionFollowSourceProjectionResponseV1Schema.parse(response.data);
}
