import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { fetchAccountMachineReplacements } from '@/api/machine/fetchAccountMachineReplacements';
import { createUserScopedSocket } from '@/api/session/sockets';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { resolveMachineEncryptionContext } from '@/api/client/encryptionKey';
import { createMachineContentCodec } from '@/api/machine/machineStoredContent';
import type { StoredCredentials } from '@/persistence';
import { waitForSocketConnect } from '@/session/transport/socket/waitForSocketConnect';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';
import { createRpcCallError, isRpcMethodNotAvailableError } from '@happier-dev/protocol/rpcErrors';
import { isPlainMachineDataKeyMarker, resolveCanonicalMachineId } from '@happier-dev/protocol';
import axios from 'axios';
import {
  markRpcRequestDisposition,
  readRpcRequestDisposition,
  type RpcRequestDisposition,
} from './rpcRequestDisposition';

export type MachineRpcRequestDisposition = RpcRequestDisposition;
export const readMachineRpcRequestDisposition = readRpcRequestDisposition;

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

async function waitForConnectWithSignal(
  connectPromise: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) {
    await connectPromise;
    return;
  }
  signal.throwIfAborted();
  let onAbort = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([connectPromise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function resolveMachineRpcContentCodec(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}>) {
  const response = await axios.get(
    `${resolveServerHttpBaseUrl()}/v1/machines/${encodeURIComponent(params.machineId)}`,
    {
      headers: {
        ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
        Authorization: `Bearer ${params.credentials.token}`,
      },
      timeout: params.timeoutMs,
      ...(params.signal ? { signal: params.signal } : {}),
    },
  );
  const raw = response.data?.machine as
    | { id?: unknown; dataEncryptionKey?: unknown }
    | null
    | undefined;
  if (String(raw?.id ?? '').trim() !== params.machineId) {
    throw new Error(`Machine ${params.machineId} was not returned by the server`);
  }
  if (
    typeof raw?.dataEncryptionKey === 'string'
    && isPlainMachineDataKeyMarker(raw.dataEncryptionKey)
  ) {
    return createMachineContentCodec({ encryptionMode: 'plain' });
  }
  if (!params.credentials.encryption) {
    throw new Error(
      `Machine ${params.machineId} requires E2EE credentials`,
    );
  }
  const encryption = resolveMachineEncryptionContext({
    token: params.credentials.token,
    encryption: params.credentials.encryption,
  });
  return createMachineContentCodec({
    encryptionMode: 'e2ee',
    encryptionKey: encryption.encryptionKey,
    encryptionVariant: encryption.encryptionVariant,
  });
}

/** One exact account-scoped machine RPC; retry and target selection stay caller-owned. */
async function callExactMachineRpc(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  method: string;
  request: unknown;
  authorization?: SocketRpcAuthorizationContext;
  timeoutMs?: number;
  signal?: AbortSignal;
}>): Promise<unknown> {
  let socket: ReturnType<typeof createUserScopedSocket> | null = null;
  let requestEmitted = false;
  try {
    params.signal?.throwIfAborted();
    const machineId = params.machineId.trim();
    if (!machineId) throw new Error('Machine id is required');
    const activeSocket = createUserScopedSocket({ token: params.credentials.token });
    socket = activeSocket;
    const timeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 20_000;
    const connectTimeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
      ? timeoutMs
      : resolveSessionControlSocketConnectTimeoutMs();
    const machineCodec = await resolveMachineRpcContentCodec({
      credentials: params.credentials,
      machineId,
      timeoutMs,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    const connectPromise = waitForSocketConnect(activeSocket as unknown as import('socket.io-client').Socket, connectTimeoutMs);
    activeSocket.connect();
    await waitForConnectWithSignal(connectPromise, params.signal);
    params.signal?.throwIfAborted();
    const encodedRequest = machineCodec.encodeRpc(params.request);
    const response = await new Promise<{ ok: boolean; result?: unknown; error?: string; errorCode?: string }>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        params.signal?.removeEventListener('abort', onAbort);
        callback();
      };
      const onAbort = () => finish(() => reject(abortReason(params.signal!)));
      params.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => finish(() => reject(Object.assign(new Error('Machine RPC call timeout'), {
        code: 'MACHINE_RPC_TIMEOUT',
      }))), timeoutMs);
      try {
        requestEmitted = true;
        activeSocket.emit(
          SOCKET_RPC_EVENTS.CALL,
          {
            method: `${machineId}:${params.method}`,
            params: encodedRequest,
            timeoutMs,
            ...(params.authorization ? { authorization: params.authorization } : {}),
          },
          (payload: { ok: boolean; result?: unknown; error?: string; errorCode?: string }) => finish(() => resolve(payload)),
        );
      } catch (error) {
        finish(() => reject(error));
      }
    });
    if (!response.ok) {
      throw createRpcCallError({ error: response.error || 'Machine RPC call failed', errorCode: response.errorCode });
    }
    return machineCodec.decodeRpc(response.result);
  } catch (error) {
    throw markRpcRequestDisposition(error, requestEmitted ? 'outcomeUnknown' : 'notSent');
  } finally {
    if (socket) {
      try {
        socket.disconnect();
        socket.close();
      } catch {
        // Preserve the original result.
      }
    }
  }
}

/**
 * The machine this recorded id IS now, when the recorded one could not be
 * reached and only then.
 *
 * A replaced machine keeps its row and gains a forward pointer, and nothing
 * re-homes the Sessions, recent paths or RPC targets that named it — so the
 * recorded id stays the predecessor forever. Resolution reuses the one
 * replacement walk the UI target resolvers and the daemon-side entitlement gate
 * already share; a second walk would let this client address a successor the
 * daemon then refuses as foreign.
 *
 * `null` whenever nothing changes hands: no chain recorded, an unreadable chain,
 * or a canonical id equal to the one already tried. The caller's fallback is the
 * original error, so every failure here is inert.
 */
async function resolveSuccessorMachineId(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
}>): Promise<string | null> {
  const machines = await fetchAccountMachineReplacements({ credentials: params.credentials });
  if (!machines) return null;
  const canonicalMachineId = resolveCanonicalMachineId(params.machineId, machines)?.machineId ?? null;
  return canonicalMachineId && canonicalMachineId !== params.machineId.trim()
    ? canonicalMachineId
    : null;
}

/**
 * One account-scoped machine RPC, addressed to the machine the recorded id names
 * TODAY.
 *
 * A user who replaces a machine keeps the Sessions the previous one hosted, so a
 * CLI- or MCP-driven send or resume must not die with the predecessor. Resolving
 * the replacement chain is a no-op unless a replacement was actually recorded,
 * so it is paid on FAILURE rather than on every call: the recorded id is
 * addressed exactly as before, and only a machine the server could find no
 * target for is re-addressed — exactly once, and only when the chain names a
 * different machine. A reached machine, including one that answered with an
 * error, pays nothing and is never re-addressed; re-running an answered call
 * against a different machine would be a correctness bug, and an unknown outcome
 * could execute twice. When nothing changes hands the ORIGINAL error surfaces
 * unchanged, because the user's problem is the RPC and not the lookup.
 */
export async function callMachineRpc(params: Readonly<{
  credentials: StoredCredentials;
  machineId: string;
  method: string;
  request: unknown;
  authorization?: SocketRpcAuthorizationContext;
  timeoutMs?: number;
  signal?: AbortSignal;
}>): Promise<unknown> {
  try {
    return await callExactMachineRpc(params);
  } catch (error) {
    // Only "the server found no target for this machine" may be re-addressed:
    // it proves the request reached no machine at all.
    if (!isRpcMethodNotAvailableError(error)) throw error;
    const successorMachineId = await resolveSuccessorMachineId({
      credentials: params.credentials,
      machineId: params.machineId,
    });
    if (!successorMachineId) throw error;
    return await callExactMachineRpc({ ...params, machineId: successorMachineId });
  }
}
