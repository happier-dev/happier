import { createUserScopedSocket } from '@/api/session/sockets';
import { fetchAccountMachineReplacements } from '@/api/machine/fetchAccountMachineReplacements';
import { MachineRpcEncryptionError, resolveMachineRpcEncryption } from '@/api/machine/resolveMachineRpcEncryption';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { Credentials } from '@/persistence';
import { waitForSocketConnect } from '@/session/transport/socket/waitForSocketConnect';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { isRpcMethodNotAvailableError } from '@happier-dev/protocol/rpcErrors';
import { resolveCanonicalMachineId } from '@happier-dev/protocol';
import type { SocketRpcAuthorizationContext } from '@happier-dev/protocol/rpc';
import { randomUUID } from 'node:crypto';
import {
  createSocketRpcDisconnectGuard,
  SocketRpcDisconnectBeforeAcknowledgementError,
} from './socketRpcDisconnectGuard';
import { createRpcAcknowledgementError, markRpcRequestDisposition, readRpcRequestDisposition } from './rpcRequestDisposition';

/**
 * Calls exactly one account-scoped machine RPC against exactly the machine id it
 * is given. The caller owns retry policy; this boundary has no timeout redrive.
 */
export async function callExactMachineRpc(params: Readonly<{
  credentials: Credentials;
  machineId: string;
  method: string;
  request: unknown;
  authorization?: SocketRpcAuthorizationContext;
  /** null delegates acknowledgement expiry to the relay's finite forwarding deadline. */
  timeoutMs?: number | null;
}>): Promise<unknown> {
  const machineId = params.machineId.trim();
  if (!machineId) throw new Error('Machine id is required');

  const socket = createUserScopedSocket({ token: params.credentials.token });
  const timeoutMs = params.timeoutMs === null
    ? null
    : typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 20_000;
  const connectTimeoutMs = typeof params.timeoutMs === 'number' && params.timeoutMs > 0
    ? params.timeoutMs
    : resolveSessionControlSocketConnectTimeoutMs();
  const requestId = randomUUID();
  let requestEmitted = false;
  let responseTimer: ReturnType<typeof setTimeout> | null = null;
  const cancelRequest = () => {
    if (!requestEmitted) return;
    try {
      socket.emit(SOCKET_RPC_EVENTS.CANCEL, { requestId });
    } catch {
      // The caller outcome remains the disconnect/timeout; server-side
      // caller-disconnect cleanup is the cancellation backstop.
    }
  };
  const disconnectGuard = createSocketRpcDisconnectGuard({
    socket: socket as unknown as import('socket.io-client').Socket,
    createError: () => new SocketRpcDisconnectBeforeAcknowledgementError(),
    onDisconnect: cancelRequest,
  });
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    try { socket.disconnect(); } catch { /* preserve the original outcome */ }
    try { socket.close(); } catch { /* preserve the original outcome */ }
  };

  try {
    const machineEncryption = await resolveMachineRpcEncryption({ credentials: params.credentials, machineId, timeoutMs: connectTimeoutMs });
    const connectPromise = waitForSocketConnect(socket as unknown as import('socket.io-client').Socket, connectTimeoutMs);
    const connectedOrDisconnected = Promise.race([connectPromise, disconnectGuard.disconnected]);
    socket.connect();
    await connectedOrDisconnected;
    disconnectGuard.throwIfDisconnected();

    const encodedRequest = machineEncryption.encryptionVariant === 'plain' ? params.request : encodeBase64(encrypt(
      machineEncryption.encryptionKey,
      machineEncryption.encryptionVariant,
      params.request,
    ));
    const responsePromise = new Promise<{ ok: boolean; result?: unknown; error?: string; errorCode?: string }>((resolve, reject) => {
      if (timeoutMs !== null) {
        responseTimer = setTimeout(() => {
          cancelRequest();
          reject(Object.assign(new Error('Machine RPC call timeout'), {
            code: 'MACHINE_RPC_TIMEOUT',
          }));
        }, timeoutMs);
      }
      try {
        requestEmitted = true;
        socket.emit(
          SOCKET_RPC_EVENTS.CALL,
          {
            method: `${machineId}:${params.method}`,
            params: encodedRequest,
            requestId,
            ...(timeoutMs !== null ? { timeoutMs } : {}),
            ...(params.authorization ? { authorization: params.authorization } : {}),
          },
          (payload: { ok: boolean; result?: unknown; error?: string; errorCode?: string }) => resolve(payload),
        );
      } catch (error) {
        reject(error);
      }
    });
    const response = await Promise.race([responsePromise, disconnectGuard.disconnected]);

    if (!response.ok) {
      throw createRpcAcknowledgementError({
        error: response.error || 'Machine RPC call failed',
        errorCode: response.errorCode,
      });
    }
    if (machineEncryption.encryptionVariant === 'plain') return response.result;
    try {
      if (typeof response.result !== 'string' || !response.result.trim()) {
        throw new MachineRpcEncryptionError('response_invalid');
      }
      const result: unknown = decrypt(
        machineEncryption.encryptionKey,
        machineEncryption.encryptionVariant,
        decodeBase64(response.result, 'base64'),
      );
      if (result === null) throw new MachineRpcEncryptionError('response_invalid');
      return result;
    } catch {
      throw new MachineRpcEncryptionError('response_invalid');
    }
  } catch (error) {
    throw readRpcRequestDisposition(error) === null
      ? markRpcRequestDisposition(error, requestEmitted ? 'outcomeUnknown' : 'notSent')
      : error;
  } finally {
    if (responseTimer) clearTimeout(responseTimer);
    disconnectGuard.dispose();
    cleanup();
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
  credentials: Credentials;
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
  credentials: Credentials;
  machineId: string;
  method: string;
  request: unknown;
  authorization?: SocketRpcAuthorizationContext;
  /** null delegates acknowledgement expiry to the relay's finite forwarding deadline. */
  timeoutMs?: number | null;
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
