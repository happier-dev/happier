import type { SessionInputLiveWork } from '@/agent/runtime/session/input/_types';
import { requestSessionInputLiveWork } from '@/agent/runtime/session/input/sessionProviderInputAdmissionRpc';
import { isDeepStrictEqual } from 'node:util';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import type { TrackedSession } from '../types';
import type { AdmittedRequesterSessionBootstrap } from '../sessionEncryption/requesterSessionCredentials';

/** The existing Session-input observer; the live inventory remains its sole census. */
export async function readTrackedSessionInputLiveWork(input: Readonly<{
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
  /** The authenticated Session network boundary; production uses the incumbent transport. */
  callRpc?: typeof callSessionRpc;
}>): Promise<SessionInputLiveWork> {
  const sessionId = input.tracked.happySessionId;
  const unknown = { session: 'unknown', input: 'unknown' } as const;
  const requester = input.requesterBootstrap;
  const stamp = input.tracked.requesterWorkAttributionV1;
  if (!sessionId || !requester && (!input.custodianAccountId || stamp
    && (stamp.accountId !== input.custodianAccountId || stamp.serverId !== input.serverId
      || stamp.machineId !== input.machineId))) return unknown;
  const isCurrent = async () => !input.signal?.aborted && input.isTrackedCurrent()
    && input.tracked.happySessionId === sessionId && (!requester
      || requester.getBoundSessionId() === sessionId && stamp !== undefined
        && isDeepStrictEqual(stamp, requester.attribution)
        && stamp.serverId === input.serverId && stamp.machineId === input.machineId
        && await requester.isCurrent());
  try {
    if (!await isCurrent()) return unknown;
    const credentials = requester?.credentials ?? input.credentials;
    return await runWithServerHttpBaseUrl(requester?.serverHttpBaseUrl ?? input.serverHttpBaseUrl, async () => {
      const transport = await resolveSessionTransportContext({ credentials, idOrPrefix: sessionId,
        ...(input.signal ? { signal: input.signal } : {}) });
      if (!transport.ok || transport.sessionId !== sessionId || !await isCurrent()) return unknown;
      const observation = await requestSessionInputLiveWork({ callRpc: async (method, request) => {
        if (!await isCurrent()) throw new Error('requester_session_not_current');
        const rpc = { token: credentials.token, sessionId, method, request,
          ...(input.signal ? { signal: input.signal } : {}) };
        const call = input.callRpc ?? callSessionRpc;
        return transport.mode === 'plain'
          ? await call({ ...rpc, mode: 'plain' })
          : await call({ ...rpc, mode: 'e2ee', ctx: transport.ctx });
      } });
      return await isCurrent() ? observation : unknown;
    });
  } catch { return unknown; }
}
