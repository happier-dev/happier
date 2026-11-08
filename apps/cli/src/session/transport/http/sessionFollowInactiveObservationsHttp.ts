import axios from '@/api/client/credentialAxios';
import { AxiosError } from 'axios';
import { SessionFollowObserveInactiveRequestV1Schema, SessionFollowObserveInactiveResponseV1Schema,
  type SessionFollowObserveInactiveResponseV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { classifyServerEndpointError, type ServerEndpointErrorClassification } from '@/api/client/classifyServerEndpointError';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';

export type InactiveSessionFollowObservationResult = SessionFollowObserveInactiveResponseV1 | null | Readonly<{
  ok: false;
  error: 'observation_unavailable';
  failure: ServerEndpointErrorClassification;
  diagnostic: Readonly<Record<string, unknown>>;
}>;

/** Read-only exact retained placement; this creates neither a runtime principal nor an ACK. */
export async function fetchInactiveSessionFollowObservations(input: Readonly<{
  token: string; destinationSessionId: string; machineId: string; installationId: string;
  reason: 'receiver-recovery' | 'manager-turn-admission';
  signal?: AbortSignal;
}>): Promise<InactiveSessionFollowObservationResult> {
  const body = SessionFollowObserveInactiveRequestV1Schema.parse({ v: 1, machineId: input.machineId, installationId: input.installationId });
  const path = SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.inactiveObservations.replace(':destinationSessionId', encodeURIComponent(input.destinationSessionId));
  try {
    const response = await axios.post<unknown>(`${resolveServerHttpBaseUrl()}${path}`, body, {
      headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.token}`,
        'X-Happier-Request-Purpose': `session-follow:${input.reason}` },
      timeout: configuration.sessionControlHttpTimeoutMs, validateStatus: () => true,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (response.status === 403 || response.status === 404) return null;
    if (response.status !== 200) throw new AxiosError('Inactive Session Follow observation HTTP failure', undefined, undefined, undefined, response);
    const parsed = SessionFollowObserveInactiveResponseV1Schema.safeParse(response.data);
    if (!parsed.success) throw new Error('Invalid inactive Session Follow observation response');
    if (parsed.data.ok && parsed.data.sessionId !== input.destinationSessionId) throw new Error('Inactive Session Follow identity mismatch');
    if (!parsed.data.ok && parsed.data.error === 'internal') throw Object.assign(new Error('Inactive Session Follow observation unavailable'), { code: parsed.data.error });
    return parsed.data;
  } catch (error) {
    // A failed observation retains source custody. Rejecting the Account-feed
    // callback would replay the same page until this optional read succeeds.
    return { ok: false, error: 'observation_unavailable', failure: classifyServerEndpointError(error),
      diagnostic: serializeAxiosErrorForLog(error) };
  }
}
