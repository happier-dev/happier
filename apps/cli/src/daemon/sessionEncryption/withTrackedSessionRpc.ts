import { isDeepStrictEqual } from 'node:util';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import type { TrackedSession } from '../types';
import type { AdmittedRequesterSessionBootstrap } from './requesterSessionCredentials';

/** Existing exact-Session transport admission shared by observers and freshness hints. */
export async function withTrackedSessionRpc<T>(input: Readonly<{
  tracked: TrackedSession;
  credentials: StoredCredentials;
  custodianAccountId: string | null;
  serverId: string;
  machineId: string;
  serverHttpBaseUrl: string;
  requesterBootstrap?: Pick<AdmittedRequesterSessionBootstrap,
    'credentials' | 'attribution' | 'serverHttpBaseUrl' | 'getBoundSessionId' | 'isCurrent'>;
  isTrackedCurrent(): boolean;
  signal?: AbortSignal;
  /** Authenticated network boundary; production uses the incumbent transport. */
  callRpc?: typeof callSessionRpc;
}>, operation: (callRpc: (method: string, request: unknown) => Promise<unknown>) => Promise<T>): Promise<T | null> {
  const sessionId = input.tracked.happySessionId;
  const requester = input.requesterBootstrap;
  const stamp = input.tracked.requesterWorkAttributionV1;
  if (!sessionId || !requester && (!input.custodianAccountId || stamp
    && (stamp.accountId !== input.custodianAccountId || stamp.serverId !== input.serverId
      || stamp.machineId !== input.machineId))) return null;
  const isCurrent = async () => !input.signal?.aborted && input.isTrackedCurrent()
    && input.tracked.happySessionId === sessionId && (!requester
      || requester.getBoundSessionId() === sessionId && stamp !== undefined
        && isDeepStrictEqual(stamp, requester.attribution)
        && stamp.serverId === input.serverId && stamp.machineId === input.machineId
        && await requester.isCurrent());
  if (!await isCurrent()) return null;
  const credentials = requester?.credentials ?? input.credentials;
  return await runWithServerHttpBaseUrl(requester?.serverHttpBaseUrl ?? input.serverHttpBaseUrl, async () => {
    const transport = await resolveSessionTransportContext({ credentials, idOrPrefix: sessionId,
      ...(input.signal ? { signal: input.signal } : {}) });
    if (!transport.ok || transport.sessionId !== sessionId || !await isCurrent()) return null;
    const result = await operation(async (method, request) => {
      if (!await isCurrent()) throw new Error('requester_session_not_current');
      const rpc = { token: credentials.token, sessionId, method, request,
        ...(input.signal ? { signal: input.signal } : {}) };
      const call = input.callRpc ?? callSessionRpc;
      return transport.mode === 'plain'
        ? await call({ ...rpc, mode: 'plain' })
        : await call({ ...rpc, mode: 'e2ee', ctx: transport.ctx });
    });
    return await isCurrent() ? result : null;
  });
}
