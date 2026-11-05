import { randomUUID } from 'node:crypto';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import tweetnacl from 'tweetnacl';
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
import { timeWebLatencyPhase, withWebLatencyTrace } from '@/daemon/externalActions/webLatencyTrace';

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
  /** Host-only observation after the transport actually issues its packet. */
  onIssued?: () => void;
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
      await timeWebLatencyPhase('session.rpc.connect', connect);
      const prefix = `${params.sessionId}:`;
      const externalAction = params.externalAction;
      const method = params.method.startsWith(prefix) ? params.method.slice(prefix.length) : params.method;
      return await readRpcObservation({ request: params.request, signal, observation: params.reattachOnReconnect, read: async (request) => {
        let authorization = externalAction?.context.externalActionExecutionAuthorization;
        const seal = authorization?.requesterAccountProjection?.sealRequesterAccountContext;
        if (seal && authorization && externalAction) {
          if (externalAction.installationId !== authorization.binding.installationId) {
            throw new Error('External Action Session installation is unavailable');
          }
          const privateKey = typeof externalAction.privateKey === 'string'
            ? decodeBase64(externalAction.privateKey, 'base64url') : externalAction.privateKey;
          const sealed = await seal({ authorization, purpose: { kind: 'machine_rpc', method, params: request },
            installationPublicKey: tweetnacl.sign.keyPair.fromSecretKey(privateKey).publicKey });
          if (!sealed?.requesterAccountContext) throw new Error('Requester Account custody unavailable');
          authorization = sealed;
        }
        const createExternalActionExecution: Parameters<typeof callSocketRpc>[0]['createExternalActionExecution'] = externalAction
          ? packet => {
            const execution = createExternalActionMachineRpcExecution({ ...externalAction, ...packet,
              context: { ...externalAction.context, externalActionExecutionAuthorization: authorization } });
            if (!execution) throw new Error('External Action Session RPC authorization is unavailable');
            return execution;
          } : undefined;
        const requestId = randomUUID();
        const result = await withWebLatencyTrace(requestId, () => timeWebLatencyPhase('session.rpc.ack', () => callSocketRpc({
          socket,
          target: { kind: 'session', id: params.sessionId },
          method,
          params: request,
          content,
          requestId,
          timeoutMs,
          signal,
          onIssued: () => { params.onIssued?.(); void timeWebLatencyPhase('session.rpc.issued', () => undefined); },
          ...(createExternalActionExecution ? { createExternalActionExecution } : {}),
        })), params.sessionId);
        return params.mode === 'plain' ? result ?? null : result;
      } });
    });
  } catch (error) {
    if (isSocketIoAckTimeoutError(error)) throw markRpcRequestDisposition(
      new RpcError('RPC call timeout', RPC_ERROR_CODES.OUTCOME_UNKNOWN), 'outcomeUnknown');
    throw readRpcRequestDisposition(error) === null ? markRpcRequestDisposition(error, 'notSent') : error;
  }
}
