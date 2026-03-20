import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { readRpcErrorCode } from '../../runtime/rpcErrors';
import {
  INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
  callSessionMachineRpcWithFallback,
  rebasePathRequestToMachineTarget,
  resolveDefaultSessionRpcFallbackRoute,
} from '../../runtime/sessionMachineRpcFallback';

type SessionCreateDirectoryRequest = Readonly<{ path: string }>;

export type SessionCreateDirectoryResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionCreateDirectory(sessionId: string, path: string): Promise<SessionCreateDirectoryResponse> {
  const request: SessionCreateDirectoryRequest = { path };
  return await callSessionMachineRpcWithFallback<SessionCreateDirectoryResponse, SessionCreateDirectoryRequest, Extract<SessionCreateDirectoryResponse, { success: false }>>({
    sessionId,
    request,
    machineMethod: RPC_METHODS.CREATE_DIRECTORY,
    sessionMethod: RPC_METHODS.CREATE_DIRECTORY,
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

type SessionListDirectoryRequest = Readonly<{ path: string }>;

export type DirectoryEntry = Readonly<{
  name: string;
  type: 'file' | 'directory' | 'other';
  size?: number;
  modified?: number;
}>;

export type SessionListDirectoryResponse =
  | Readonly<{ success: true; entries: DirectoryEntry[] }>
  | Readonly<{ success: false; error: string }>;

export async function sessionListDirectory(sessionId: string, path: string): Promise<SessionListDirectoryResponse> {
  const request: SessionListDirectoryRequest = { path };
  return await callSessionMachineRpcWithFallback<SessionListDirectoryResponse, SessionListDirectoryRequest, Extract<SessionListDirectoryResponse, { success: false }>>({
    sessionId,
    request,
    machineMethod: RPC_METHODS.LIST_DIRECTORY,
    sessionMethod: RPC_METHODS.LIST_DIRECTORY,
    toMachineRequest: rebasePathRequestToMachineTarget,
    resolveFallbackRoute: async () => resolveDefaultSessionRpcFallbackRoute({
      sessionId,
      inactiveResponse: {
        success: false,
        error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
      },
    }),
    errorResponse: (error) => ({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }),
  });
}

type SessionGetDirectoryTreeRequest = Readonly<{ path: string; maxDepth: number }>;

export type TreeNode = Readonly<{
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modified?: number;
  children?: TreeNode[];
}>;

export type SessionGetDirectoryTreeResponse =
  | Readonly<{ success: true; tree: TreeNode }>
  | Readonly<{ success: false; error: string }>;

export async function sessionGetDirectoryTree(
  sessionId: string,
  path: string,
  maxDepth: number,
): Promise<SessionGetDirectoryTreeResponse> {
  const request: SessionGetDirectoryTreeRequest = { path, maxDepth };
  return await callSessionMachineRpcWithFallback<SessionGetDirectoryTreeResponse, SessionGetDirectoryTreeRequest, Extract<SessionGetDirectoryTreeResponse, { success: false }>>({
    sessionId,
    request,
    machineMethod: RPC_METHODS.GET_DIRECTORY_TREE,
    sessionMethod: RPC_METHODS.GET_DIRECTORY_TREE,
    toMachineRequest: rebasePathRequestToMachineTarget,
    resolveFallbackRoute: async () => resolveDefaultSessionRpcFallbackRoute({
      sessionId,
      inactiveResponse: {
        success: false,
        error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
      },
    }),
    errorResponse: (error) => ({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    }),
  });
}
