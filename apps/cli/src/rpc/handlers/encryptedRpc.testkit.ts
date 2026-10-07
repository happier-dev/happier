import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcRequest } from '@/api/rpc/types';
import { socketRpcCodec, type SocketRpcContent } from '@happier-dev/sync-client';

type EncryptionVariant = 'legacy';

interface CreateEncryptedRpcTestClientOptions {
  scopePrefix: string;
  /** Models the Home's authenticated ingress stamp, not encrypted caller input. */
  callerAuthority?: RpcRequest['callerAuthority'];
  registerHandlers: (manager: RpcHandlerManager) => void;
  encryptionKey?: Uint8Array;
  encryptionVariant?: EncryptionVariant;
  logger?: (message: string, ...args: unknown[]) => void;
}

export interface EncryptedRpcTestClient {
  manager: RpcHandlerManager;
  call<TResponse, TRequest>(method: string, request: TRequest): Promise<TResponse>;
}

export function createEncryptedRpcTestClient(
  options: Readonly<CreateEncryptedRpcTestClientOptions>,
): EncryptedRpcTestClient {
  const encryptionKey = options.encryptionKey ?? new Uint8Array(32).fill(7);
  const encryptionVariant = options.encryptionVariant ?? 'legacy';
  const logger = options.logger ?? (() => undefined);

  const manager = new RpcHandlerManager({
    scopePrefix: options.scopePrefix,
    encryptionKey,
    encryptionVariant,
    logger,
  });
  options.registerHandlers(manager);
  let requestSequence = 0;
  const content = {
    mode: 'e2ee',
    cipher: {
      async encryptRaw(value: unknown) {
        return encodeBase64(encrypt(encryptionKey, encryptionVariant, value));
      },
      async decryptRaw(ciphertext: string) {
        return decrypt(encryptionKey, encryptionVariant, decodeBase64(ciphertext));
      },
    },
  } satisfies SocketRpcContent;

  const call = async <TResponse, TRequest>(method: string, request: TRequest): Promise<TResponse> => {
    const boundMethod = `${options.scopePrefix}:${method}`;
    const callId = (++requestSequence).toString(16).padStart(32, '0');
    const encryptedParams = await socketRpcCodec.encodeParams(content, request, { method: boundMethod, callId });
    const rpcRequest: RpcRequest = {
      method: boundMethod,
      params: encryptedParams,
      requestId: `${options.scopePrefix}:test-request:${requestSequence}`,
      ...(options.callerAuthority ? { callerAuthority: options.callerAuthority } : {}),
    };
    const encryptedResponse = await manager.handleRequest(rpcRequest);
    return await socketRpcCodec.decodeResult(content, { ok: true, result: encryptedResponse }, callId) as TResponse;
  };

  return { manager, call };
}
