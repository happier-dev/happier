import { isDeepStrictEqual } from 'node:util';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { callSessionRpc } from '@/session/transport/rpc/sessionRpc';
import type { TrackedSession } from '../types';
import type { AdmittedRequesterSessionBootstrap } from './requesterSessionCredentials';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import { createSessionSystemRecordPayloadService } from '@/session/systemRecords/sessionSystemRecordPayloadService';
import { fetchSessionSystemRecord, upsertSessionSystemRecord } from '@/session/transport/http/sessionSystemRecordsHttp';

/** Existing exact-Session transport admission shared by observers and freshness hints. */
export async function withTrackedSessionRpc<T>(input: Readonly<{
  tracked: TrackedSession;
  credentials: StoredCredentials;
  custodianAccountId: string | null;
  serverId: string;
  machineId: string;
  serverHttpBaseUrl: string;
  requesterBootstrap?: Pick<AdmittedRequesterSessionBootstrap,
    'credentials' | 'attribution' | 'serverHttpBaseUrl' | 'getBoundSessionId' | 'isCurrent'>
    & Partial<Pick<AdmittedRequesterSessionBootstrap, 'savedSecretOperationContext'>>;
  isTrackedCurrent(): boolean;
  signal?: AbortSignal;
  /** Omission retains the transport default; null uses the caller's lifetime. */
  timeoutMs?: Parameters<typeof callSessionRpc>[0]['timeoutMs'];
  /** Exit settlement retains the owning Home lifetime after the stop caller retires. */
  retainedRecordSignal?: AbortSignal;
  /** Authenticated network boundary; production uses the incumbent transport. */
  callRpc?: typeof callSessionRpc;
}>, operation: (callRpc: (method: string, request: unknown) => Promise<unknown>, access: Readonly<{
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  sessionId: string;
  rawSession: RawSessionRecord;
  accountEncryptionMode: 'plain' | 'e2ee';
  systemRecords: ReturnType<typeof createSessionSystemRecordPayloadService>;
  isRecordCurrent(): Promise<boolean>;
  isCurrent(): Promise<boolean>;
}>) => Promise<T>): Promise<T | null> {
  const sessionId = input.tracked.happySessionId;
  const requester = input.requesterBootstrap;
  const stamp = input.tracked.requesterWorkAttributionV1;
  if (!sessionId || !requester && (!input.custodianAccountId || stamp
    && (stamp.accountId !== input.custodianAccountId || stamp.serverId !== input.serverId
      || stamp.machineId !== input.machineId))) return null;
  const authorityCurrent = async (signal: AbortSignal | undefined) => !signal?.aborted && input.isTrackedCurrent()
    && input.tracked.happySessionId === sessionId && (!requester
      || requester.getBoundSessionId() === sessionId && stamp !== undefined
        && isDeepStrictEqual(stamp, requester.attribution)
        && stamp.serverId === input.serverId && stamp.machineId === input.machineId
        && await requester.isCurrent());
  const isCurrent = () => authorityCurrent(input.signal);
  const isRecordCurrent = () => authorityCurrent(input.retainedRecordSignal ?? input.signal);
  if (!await isCurrent()) return null;
  const credentials = requester?.credentials ?? input.credentials;
  return await runWithServerHttpBaseUrl(requester?.serverHttpBaseUrl ?? input.serverHttpBaseUrl, async () => {
    const transport = await resolveSessionTransportContext({ reason: 'session-control', credentials, idOrPrefix: sessionId,
      ...(input.signal ? { signal: input.signal } : {}) });
    if (!transport.ok || transport.sessionId !== sessionId || !await isCurrent()) return null;
    const systemRecords = createSessionSystemRecordPayloadService({ sessionId,
      getStoredContentEncryptionContext: () => transport.mode === 'plain' ? { mode: 'plain' } : transport,
      fetchSessionSystemRecord: async request => {
        if (!await isRecordCurrent()) throw new Error('requester_session_not_current');
        return await runWithServerHttpBaseUrl(requester?.serverHttpBaseUrl ?? input.serverHttpBaseUrl,
          () => fetchSessionSystemRecord({ token: credentials.token, sessionId, ...request }));
      },
      upsertSessionSystemRecord: async request => {
        if (!await isRecordCurrent()) throw new Error('requester_session_not_current');
        await runWithServerHttpBaseUrl(requester?.serverHttpBaseUrl ?? input.serverHttpBaseUrl,
          () => upsertSessionSystemRecord({ token: credentials.token, sessionId, ...request }));
      },
    });
    const result = await operation(async (method, request) => {
      if (!await isCurrent()) throw new Error('requester_session_not_current');
      const rpc = { token: credentials.token, sessionId, method, request,
        ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
        ...(input.signal ? { signal: input.signal } : {}) };
      const call = input.callRpc ?? callSessionRpc;
      return transport.mode === 'plain'
        ? await call({ ...rpc, mode: 'plain' })
        : await call({ ...rpc, mode: 'e2ee', ctx: transport.ctx });
    }, { credentials, serverHttpBaseUrl: requester?.serverHttpBaseUrl ?? input.serverHttpBaseUrl, sessionId, isCurrent,
      rawSession: transport.rawSession, accountEncryptionMode: transport.accountEncryptionCurrentness.mode, systemRecords, isRecordCurrent });
    return await isCurrent() ? result : null;
  });
}
