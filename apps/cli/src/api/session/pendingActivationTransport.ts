import axios from '@/api/client/credentialAxios';
import { PendingActivationFailureDetailsV1Schema, PendingActivationFailureRequestV1Schema, PendingActivationFailureResponseV1Schema, type PendingActivationFailureDetailsV1 } from '@happier-dev/protocol/sessions/pending/pendingActivationAuthorizationV1';
import type { PendingActivationFailureCodeV1 } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '@/session/transport/http/serverHttpBaseUrl';

export async function reportPendingSessionActivationFailure(params: Readonly<{
  token: string;
  sessionId: string;
  requestId: string;
  requestedAt: number;
  failureCode: PendingActivationFailureCodeV1;
  failureDetails?: PendingActivationFailureDetailsV1;
}>): Promise<Readonly<{ didFail: boolean }>> {
  const body = PendingActivationFailureRequestV1Schema.parse({
    requestId: params.requestId,
    requestedAt: params.requestedAt,
    failureCode: params.failureCode,
  });
  const response = await axios.post(
    `${resolveServerHttpBaseUrl()}/v2/sessions/${encodeURIComponent(params.sessionId)}/pending/activation/fail`,
    body,
    {
      headers: { Authorization: `Bearer ${params.token}`, 'Content-Type': 'application/json' },
      timeout: configuration.sessionControlHttpTimeoutMs,
      ...(params.failureDetails ? { params: { failureDetails: JSON.stringify(PendingActivationFailureDetailsV1Schema.parse(params.failureDetails)) } } : {}),
    },
  );
  const parsed = PendingActivationFailureResponseV1Schema.parse(response.data);
  return { didFail: parsed.didFail };
}
