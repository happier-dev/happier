import { randomUUID } from 'node:crypto';
import {
  callSocketRpc,
  isSocketIoAckTimeoutError,
  markRpcRequestDisposition,
  readRpcRequestDisposition,
  type RpcRequestDisposition,
  type SocketRpcContent,
} from '@happier-dev/sync-client';
import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import type { SessionEncryptionContext } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveSessionControlSocketConnectTimeoutMs } from '@/session/transport/shared/sessionTimeouts';
import { readRpcObservation, withUserScopedRpcSocket, type RpcObservationOptions } from './withUserScopedRpcSocket';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions';
import { createExternalActionMachineRpcExecution, type ExternalActionMachineRequestSigningKey } from '@/api/externalActionExecutionAuthorization';

export type SessionRpcRequestDisposition = RpcRequestDisposition;
export const readSessionRpcRequestDisposition = readRpcRequestDisposition;

type SessionRpcEncryption =
  | Readonly<{ mode: 'plain'; ctx?: null }>
  | Readonly<{ mode?: 'e2ee'; ctx: SessionEncryptionContext }>;

/** The Session content owner is shared by user and authenticated daemon RPC transports. */
export function resolveSessionRpcContent(params: SessionRpcEncryption): SocketRpcContent {
  return params.mode === 'plain' ? { mode: 'plain' } : {
    mode: 'e2ee',
    cipher: {
      encryptRaw: async (value) => encodeBase64(encrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, value), 'base64'),
      decryptRaw: async (ciphertext) => decrypt(params.ctx.encryptionKey, params.ctx.encryptionVariant, decodeBase64(ciphertext, 'base64')),
    },
  };
}

type CallSessionRpcParams = Readonly<{
  token: string;
  sessionId: string;
  authorityCeiling?: 'account_automation';
  method: string;
  request: unknown;
  /** Null delegates acknowledgement lifetime to the caller signal/server lifecycle. */
  timeoutMs?: number | null;
  signal?: AbortSignal;
  /** Reissue only a read-only observation when the supervised transport reconnects. */
  reattachOnReconnect?: RpcObservationOptions;
  externalAction?: Readonly<{
    context: ActionExecutorContext;
    effectActionId: string;
    installationId: string;
    privateKey: ExternalActionMachineRequestSigningKey;
  }>;
}> & SessionRpcEncryption;

export async function callSessionRpc(params: CallSessionRpcParams): Promise<unknown> {
  const timeoutMs = params.timeoutMs === null ? null
    : typeof params.timeoutMs === 'number' && params.timeoutMs > 0 ? params.timeoutMs : 20_000;
  const connectTimeoutMs = typeof timeoutMs === 'number' && typeof params.timeoutMs === 'number'
    ? timeoutMs : resolveSessionControlSocketConnectTimeoutMs();
  const content = resolveSessionRpcContent(params);
  try {
    return await withUserScopedRpcSocket({
      token: params.token, connectTimeoutMs, signal: params.signal,
      ...(params.authorityCeiling ? { authorityCeiling: params.authorityCeiling } : {}),
      disconnectMessage: 'RPC socket disconnected before acknowledgement',
      ...(params.reattachOnReconnect ? { reattachOnReconnect: true } : {}),
    }, async (socket, connect, signal) => {
      await connect();
      const prefix = `${params.sessionId}:`;
      const externalAction = params.externalAction;
      const createExternalActionExecution: Parameters<typeof callSocketRpc>[0]['createExternalActionExecution'] = externalAction
        ? (request) => {
          const execution = createExternalActionMachineRpcExecution({ ...externalAction, ...request });
          if (!execution) throw new Error('External Action Session RPC authorization is unavailable');
          return execution;
        } : undefined;
      return await readRpcObservation({ request: params.request, signal, observation: params.reattachOnReconnect, read: async (request) => {
        const result = await callSocketRpc({
          socket,
          target: { kind: 'session', id: params.sessionId },
          method: params.method.startsWith(prefix) ? params.method.slice(prefix.length) : params.method,
          params: request,
          content,
          requestId: randomUUID(),
          timeoutMs,
          signal,
          ...(createExternalActionExecution ? { createExternalActionExecution } : {}),
        });
        return params.mode === 'plain' ? result ?? null : result;
      } });
    });
  } catch (error) {
    if (isSocketIoAckTimeoutError(error)) throw markRpcRequestDisposition(new Error('RPC call timeout'), 'outcomeUnknown');
    throw readRpcRequestDisposition(error) === null ? markRpcRequestDisposition(error, 'notSent') : error;
  }
}
