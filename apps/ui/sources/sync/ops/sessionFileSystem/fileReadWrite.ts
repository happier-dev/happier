import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { encodeBase64 } from '@/encryption/base64';
import { downloadSessionPathToBytesViaTransfer } from '@/sync/domains/files/transfers/sessionPathTransferRpc';

import { readRpcErrorCode } from '../../runtime/rpcErrors';
import {
  INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
  callSessionMachineRpcWithFallback,
  createSessionMachineRpcFallbackCaller,
  rebasePathRequestToMachineTarget,
  resolveDefaultSessionRpcFallbackRoute,
} from '../../runtime/sessionMachineRpcFallback';

type SessionReadFileRequest = Readonly<{ path: string }>;

export type SessionReadFileResponse =
  | Readonly<{ success: true; content: string }>
  | Readonly<{ success: false; error: string }>;

export async function sessionReadFile(sessionId: string, path: string): Promise<SessionReadFileResponse> {
  const request: SessionReadFileRequest = { path };
  const caller = createSessionMachineRpcFallbackCaller<Extract<SessionReadFileResponse, { success: false }>>({
    sessionId,
    resolveFallbackRoute: async () => resolveDefaultSessionRpcFallbackRoute({
      sessionId,
      inactiveResponse: {
        success: false,
        error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
      },
    }),
    callSessionRoute: async <TResponse extends Readonly<{ success: boolean }>, TRequest>({
      sessionId: activeSessionId,
      route,
      callParams,
    }: Readonly<{
      sessionId: string;
      route: Readonly<{ kind: 'server_routed_stream'; serverId: string | undefined }>;
      callParams: Readonly<{
        request: TRequest;
        machineMethod: string;
        sessionMethod: string;
        toMachineRequest?: ((input: Readonly<{
          request: TRequest;
          machineTarget: Readonly<{ machineId: string; basePath: string }>;
        }>) => TRequest) | null;
      }>;
    }>): Promise<TResponse> => {
      const readRequest = callParams.request as SessionReadFileRequest;
      const download = await downloadSessionPathToBytesViaTransfer({
        sessionId: activeSessionId,
        path: readRequest.path,
        forceSessionRpcServerId: route.serverId,
      });
      if (!download.success) {
        return {
          success: false,
          error: download.error,
        } as unknown as TResponse;
      }
      return {
        success: true,
        content: encodeBase64(download.bytes, 'base64'),
      } as unknown as TResponse;
    },
    errorResponse: (error) => ({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }),
  });

  return await caller.call<SessionReadFileResponse, SessionReadFileRequest>({
    request,
    machineMethod: RPC_METHODS.READ_FILE,
    sessionMethod: RPC_METHODS.READ_FILE,
    toMachineRequest: rebasePathRequestToMachineTarget,
  });
}

type SessionWriteFileRequest = Readonly<{
  path: string;
  content: string;
  expectedHash?: string | null;
}>;

export type SessionWriteFileResponse =
  | Readonly<{ success: true; hash: string }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionWriteFile(
  sessionId: string,
  path: string,
  content: string,
  expectedHash?: string | null,
): Promise<SessionWriteFileResponse> {
  const contentBase64 = encodeBase64(new TextEncoder().encode(content), 'base64');
  const request: SessionWriteFileRequest =
    expectedHash === undefined
      ? { path, content: contentBase64 }
      : { path, content: contentBase64, expectedHash };

  return await callSessionMachineRpcWithFallback<SessionWriteFileResponse, SessionWriteFileRequest, Extract<SessionWriteFileResponse, { success: false }>>({
    sessionId,
    request,
    machineMethod: RPC_METHODS.WRITE_FILE,
    sessionMethod: RPC_METHODS.WRITE_FILE,
    toMachineRequest: rebasePathRequestToMachineTarget,
    resolveFallbackRoute: async () => resolveDefaultSessionRpcFallbackRoute({
      sessionId,
      inactiveResponse: {
        success: false,
        error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      },
    }),
    errorResponse: (error: unknown) => ({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    }),
  });
}
