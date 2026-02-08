import { decodeBase64, decrypt, encodeBase64, encrypt } from '@/api/encryption';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcRequest } from '@/api/rpc/types';

type EncryptionVariant = 'legacy';

interface CreateEncryptedRpcTestClientOptions {
  scopePrefix: string;
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

  const call = async <TResponse, TRequest>(method: string, request: TRequest): Promise<TResponse> => {
    const encryptedParams = encodeBase64(encrypt(encryptionKey, encryptionVariant, request));
    const rpcRequest: RpcRequest = {
      method: `${options.scopePrefix}:${method}`,
      params: encryptedParams,
    };
    const encryptedResponse = await manager.handleRequest(rpcRequest);
    return decrypt(encryptionKey, encryptionVariant, decodeBase64(encryptedResponse)) as TResponse;
  };

  return { manager, call };
}
