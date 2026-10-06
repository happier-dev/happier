import axios from 'axios';
import { SessionFollowSourceProjectionRequestV1Schema, SessionFollowSourceProjectionResponseV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import type { SessionFollowSourceProjectionResponseV1 } from '@happier-dev/protocol';

import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

export async function fetchSessionFollowSourceProjection(input: Readonly<{
  token: string;
  destinationSessionId: string;
  sourceSessionId: string;
  edgeKind?: 'reports_to';
  attachedAt?: number;
  readMode?: 'incremental' | 'initial_current_snapshot';
  afterTranscriptSeq: number;
  observedTranscriptSeq: number;
  limit: number;
  signal: AbortSignal;
}>): Promise<SessionFollowSourceProjectionResponseV1 | null> {
  const body = SessionFollowSourceProjectionRequestV1Schema.parse({
    v: 1,
    sourceSessionId: input.sourceSessionId,
    ...(input.edgeKind ? { edgeKind: input.edgeKind, attachedAt: input.attachedAt } : {}),
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
  if (response.status !== 200) throw new Error(`Unexpected Session Follow source projection status: ${response.status}`);
  return SessionFollowSourceProjectionResponseV1Schema.parse(response.data);
}
