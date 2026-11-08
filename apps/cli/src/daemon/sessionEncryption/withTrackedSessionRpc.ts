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

type ResolvedSessionTransport = Extract<Awaited<ReturnType<typeof resolveSessionTransportContext>>, { ok: true }>;
type SessionRpcEncryption = Readonly<{ mode: 'plain' } | { mode: 'e2ee'; ctx: Extract<ResolvedSessionTransport, { mode: 'e2ee' }>['ctx'] }>;
type SessionRpcCall = (method: string, request: unknown) => Promise<unknown>;

type TrackedSessionRpcInput = Readonly<{
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
}>;

/**
 * RPC encryption context the daemon already opened for a tracked runner. It holds no Session
 * record (record facts are always read fresh), lives exactly as long as the tracked object and its
 * credential/Home identity, and a failed RPC (re-key, encryption-mode change, lost Session) drops
 * it so the next call rebuilds once. Never time-based.
 */
const retainedRpcEncryption = new WeakMap<TrackedSession, Readonly<{
  sessionId: string; token: string; serverHttpBaseUrl: string; encryption: SessionRpcEncryption;
}>>();

type AdmittedTrackedSession = Readonly<{
  sessionId: string;
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  isCurrent(): Promise<boolean>;
  isRecordCurrent(): Promise<boolean>;
}>;

async function runAdmittedTrackedSession<T>(input: TrackedSessionRpcInput,
  run: (admitted: AdmittedTrackedSession) => Promise<T | null>): Promise<T | null> {
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
  const serverHttpBaseUrl = requester?.serverHttpBaseUrl ?? input.serverHttpBaseUrl;
  return await runWithServerHttpBaseUrl(serverHttpBaseUrl,
    () => run({ sessionId, credentials, serverHttpBaseUrl, isCurrent, isRecordCurrent }));
}

function createTrackedSessionRpcCall(input: TrackedSessionRpcInput, admitted: AdmittedTrackedSession,
  encryption: SessionRpcEncryption, onFailure?: () => void): SessionRpcCall {
  return async (method, request) => {
    if (!await admitted.isCurrent()) throw new Error('requester_session_not_current');
    const rpc = { token: admitted.credentials.token, sessionId: admitted.sessionId, method, request,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.signal ? { signal: input.signal } : {}) };
    const call = input.callRpc ?? callSessionRpc;
    try {
      return encryption.mode === 'plain'
        ? await call({ ...rpc, mode: 'plain' })
        : await call({ ...rpc, mode: 'e2ee', ctx: encryption.ctx });
    } catch (error) {
      onFailure?.();
      throw error;
    }
  };
}

const resolveTrackedSessionTransport = async (input: TrackedSessionRpcInput, admitted: AdmittedTrackedSession) => {
  const transport = await resolveSessionTransportContext({ reason: 'session-control', credentials: admitted.credentials,
    idOrPrefix: admitted.sessionId, ...(input.signal ? { signal: input.signal } : {}) });
  return transport.ok && transport.sessionId === admitted.sessionId && await admitted.isCurrent() ? transport : null;
};

/** Existing exact-Session transport admission shared by observers and freshness hints; reads the Session record fresh. */
export async function withTrackedSessionRpc<T>(input: TrackedSessionRpcInput, operation: (callRpc: SessionRpcCall, access: Readonly<{
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  sessionId: string;
  rawSession: RawSessionRecord;
  accountEncryptionMode: 'plain' | 'e2ee';
  systemRecords: ReturnType<typeof createSessionSystemRecordPayloadService>;
  isRecordCurrent(): Promise<boolean>;
  isCurrent(): Promise<boolean>;
}>) => Promise<T>): Promise<T | null> {
  return await runAdmittedTrackedSession(input, async admitted => {
    const transport = await resolveTrackedSessionTransport(input, admitted);
    if (!transport) return null;
    const { credentials, sessionId, isRecordCurrent } = admitted;
    const systemRecords = createSessionSystemRecordPayloadService({ sessionId,
      getStoredContentEncryptionContext: () => transport.mode === 'plain' ? { mode: 'plain' } : transport,
      fetchSessionSystemRecord: async request => {
        if (!await isRecordCurrent()) throw new Error('requester_session_not_current');
        return await runWithServerHttpBaseUrl(admitted.serverHttpBaseUrl,
          () => fetchSessionSystemRecord({ token: credentials.token, sessionId, ...request }));
      },
      upsertSessionSystemRecord: async request => {
        if (!await isRecordCurrent()) throw new Error('requester_session_not_current');
        await runWithServerHttpBaseUrl(admitted.serverHttpBaseUrl,
          () => upsertSessionSystemRecord({ token: credentials.token, sessionId, ...request }));
      },
    });
    return await operation(createTrackedSessionRpcCall(input, admitted, transport), { credentials,
      serverHttpBaseUrl: admitted.serverHttpBaseUrl, sessionId, isCurrent: admitted.isCurrent,
      rawSession: transport.rawSession, accountEncryptionMode: transport.accountEncryptionCurrentness.mode,
      systemRecords, isRecordCurrent });
  });
}

/**
 * Passive RPC observations that consume no Session record facts: reuse the RPC encryption context
 * held for this tracked runner instead of reading the Session record on every call.
 */
export async function withTrackedSessionRpcContext<T>(input: TrackedSessionRpcInput,
  operation: (callRpc: SessionRpcCall) => Promise<T>): Promise<T | null> {
  return await runAdmittedTrackedSession(input, async admitted => {
    const held = retainedRpcEncryption.get(input.tracked);
    let encryption = held && held.sessionId === admitted.sessionId && held.token === admitted.credentials.token
      && held.serverHttpBaseUrl === admitted.serverHttpBaseUrl ? held.encryption : null;
    if (!encryption) {
      const transport = await resolveTrackedSessionTransport(input, admitted);
      if (!transport) return null;
      encryption = transport.mode === 'plain' ? { mode: 'plain' } : { mode: 'e2ee', ctx: transport.ctx };
      retainedRpcEncryption.set(input.tracked, { sessionId: admitted.sessionId, token: admitted.credentials.token,
        serverHttpBaseUrl: admitted.serverHttpBaseUrl, encryption });
    }
    const opened = encryption;
    // The existing failure path is the only invalidation signal for held material.
    return await operation(createTrackedSessionRpcCall(input, admitted, opened, () => {
      if (retainedRpcEncryption.get(input.tracked)?.encryption === opened) retainedRpcEncryption.delete(input.tracked);
    }));
  });
}
