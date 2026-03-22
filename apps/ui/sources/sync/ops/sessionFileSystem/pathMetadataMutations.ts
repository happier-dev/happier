import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { readRpcErrorCode } from '../../runtime/rpcErrors';
import {
  INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
  callSessionMachineRpcWithFallback,
  rebaseFromToRequestToMachineTarget,
  rebasePathRequestToMachineTarget,
  resolveDefaultSessionRpcFallbackRoute,
} from '../../runtime/sessionMachineRpcFallback';

type SessionStatFileRequest = Readonly<{ path: string }>;

export type SessionStatFileResponse =
  | Readonly<{
      success: true;
      exists: boolean;
      kind?: 'file' | 'directory' | 'other';
      sizeBytes?: number;
      modifiedMs?: number;
    }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionStatFile(sessionId: string, path: string): Promise<SessionStatFileResponse> {
  const request: SessionStatFileRequest = { path };
  return await callSessionMachineRpcWithFallback<SessionStatFileResponse, SessionStatFileRequest, Extract<SessionStatFileResponse, { success: false }>>({
    sessionId,
    request,
    machineMethod: RPC_METHODS.STAT_FILE,
    sessionMethod: RPC_METHODS.STAT_FILE,
    toMachineRequest: rebasePathRequestToMachineTarget,
    resolveFallbackRoute: async () => resolveDefaultSessionRpcFallbackRoute({
      sessionId,
      inactiveResponse: {
        success: false,
        error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      },
    }),
    errorResponse: (error) => ({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    }),
  });
}

type SessionRenamePathRequest = Readonly<{ from: string; to: string; overwrite?: boolean }>;

export type SessionRenamePathResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionRenamePath(
  sessionId: string,
  input: Readonly<{ from: string; to: string; overwrite?: boolean }>,
): Promise<SessionRenamePathResponse> {
  const request: SessionRenamePathRequest = {
    from: input.from,
    to: input.to,
    overwrite: input.overwrite,
  };

  return await callSessionMachineRpcWithFallback<SessionRenamePathResponse, SessionRenamePathRequest, Extract<SessionRenamePathResponse, { success: false }>>({
    sessionId,
    request,
    machineMethod: RPC_METHODS.RENAME_PATH,
    sessionMethod: RPC_METHODS.RENAME_PATH,
    toMachineRequest: rebaseFromToRequestToMachineTarget,
    resolveFallbackRoute: async () => resolveDefaultSessionRpcFallbackRoute({
      sessionId,
      inactiveResponse: {
        success: false,
        error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      },
    }),
    errorResponse: (error) => ({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    }),
  });
}

type SessionDeletePathRequest = Readonly<{ path: string; recursive?: boolean }>;

export type SessionDeletePathResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionDeletePath(
  sessionId: string,
  input: Readonly<{ path: string; recursive?: boolean }>,
): Promise<SessionDeletePathResponse> {
  const request: SessionDeletePathRequest = {
    path: input.path,
    recursive: input.recursive,
  };

  return await callSessionMachineRpcWithFallback<SessionDeletePathResponse, SessionDeletePathRequest, Extract<SessionDeletePathResponse, { success: false }>>({
    sessionId,
    request,
    machineMethod: RPC_METHODS.DELETE_PATH,
    sessionMethod: RPC_METHODS.DELETE_PATH,
    toMachineRequest: rebasePathRequestToMachineTarget,
    resolveFallbackRoute: async () => resolveDefaultSessionRpcFallbackRoute({
      sessionId,
      inactiveResponse: {
        success: false,
        error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      },
    }),
    errorResponse: (error) => ({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    }),
  });
}
