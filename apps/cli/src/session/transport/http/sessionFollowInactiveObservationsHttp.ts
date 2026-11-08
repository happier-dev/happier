import axios from '@/api/client/credentialAxios';
import { AxiosError } from 'axios';
import { SessionFollowObserveInactiveRequestV1Schema, SessionFollowObserveInactiveResponseV1Schema,
  SessionFollowPendingReceiversResponseV1Schema, type SessionFollowPendingReceiversResponseV1,
  type SessionFollowObserveInactiveResponseV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowTransportV1';
import { SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { configuration } from '@/configuration';
import { classifyServerEndpointError, type ServerEndpointErrorClassification } from '@/api/client/classifyServerEndpointError';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';

type FollowObservationUnavailable = Readonly<{
  ok: false;
  error: 'observation_unavailable';
  failure: ServerEndpointErrorClassification;
  diagnostic: Readonly<Record<string, unknown>>;
}>;
export type InactiveSessionFollowObservationResult = SessionFollowObserveInactiveResponseV1 | null | FollowObservationUnavailable;
export type PendingSessionFollowReceiversResult = SessionFollowPendingReceiversResponseV1 | null | FollowObservationUnavailable;

type FollowObservationScope = Readonly<{
  token: string; machineId: string; installationId: string; signal?: AbortSignal;
  reason: 'receiver-recovery' | 'manager-turn-admission';
}>;

/** Read-only exact retained placement; this creates neither a runtime principal nor an ACK. */
export async function fetchInactiveSessionFollowObservations(input: FollowObservationScope & Readonly<{
  destinationSessionId: string;
}>): Promise<InactiveSessionFollowObservationResult> {
  const path = SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.inactiveObservations.replace(':destinationSessionId', encodeURIComponent(input.destinationSessionId));
  return requestFollowObservation({ ...input, path, responseSchema: SessionFollowObserveInactiveResponseV1Schema,
    validate: result => {
      if (result.ok && result.sessionId !== input.destinationSessionId) throw new Error('Inactive Session Follow identity mismatch');
    } });
}

/** One Account read selects only receivers whose existing source custody still has work. */
export async function fetchPendingSessionFollowReceivers(input: FollowObservationScope): Promise<PendingSessionFollowReceiversResult> {
  return requestFollowObservation({ ...input, path: SESSION_FOLLOW_SOURCES_HTTP_PATHS_V1.pendingReceivers,
    responseSchema: SessionFollowPendingReceiversResponseV1Schema });
}

async function requestFollowObservation<T extends Readonly<{ ok: boolean; error?: string }>>(input: FollowObservationScope & Readonly<{
  path: string; responseSchema: { parse: (value: unknown) => T }; validate?: (value: T) => void;
}>): Promise<T | null | FollowObservationUnavailable> {
  const body = SessionFollowObserveInactiveRequestV1Schema.parse({ v: 1, machineId: input.machineId, installationId: input.installationId });
  try {
    const response = await axios.post<unknown>(`${resolveServerHttpBaseUrl()}${input.path}`, body, {
      headers: { ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(), Authorization: `Bearer ${input.token}`,
        'X-Happier-Request-Purpose': `session-follow:${input.reason}` },
      timeout: configuration.sessionControlHttpTimeoutMs, validateStatus: () => true,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (response.status === 403 || response.status === 404) return null;
    if (response.status !== 200) throw new AxiosError('Inactive Session Follow observation HTTP failure', undefined, undefined, undefined, response);
    const result = input.responseSchema.parse(response.data);
    input.validate?.(result);
    if (!result.ok && result.error === 'internal') throw Object.assign(new Error('Inactive Session Follow observation unavailable'), { code: result.error });
    return result;
  } catch (error) {
    // A failed observation retains source custody. Rejecting the Account-feed
    // callback would replay the same page until this optional read succeeds.
    return { ok: false, error: 'observation_unavailable', failure: classifyServerEndpointError(error),
      diagnostic: serializeAxiosErrorForLog(error) };
  }
}
