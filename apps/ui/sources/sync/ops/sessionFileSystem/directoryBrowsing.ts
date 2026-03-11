import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { apiSocket } from '../../api/session/apiSocket';
import { assertRpcResponseWithSuccess } from '../../runtime/assertRpcResponseWithSuccess';
import { readRpcErrorCode } from '../../runtime/rpcErrors';
import {
  canUseSessionRpc,
  readMachineTargetForSession,
  resolveMachinePathFromSessionBase,
  shouldFallbackToSessionRpc,
} from '../sessionMachineTarget';
import { INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR } from './_shared';

type SessionCreateDirectoryRequest = Readonly<{ path: string }>;

export type SessionCreateDirectoryResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionCreateDirectory(sessionId: string, path: string): Promise<SessionCreateDirectoryResponse> {
  try {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (machineTarget) {
      try {
        const request: SessionCreateDirectoryRequest = {
          path: resolveMachinePathFromSessionBase({ basePath: machineTarget.basePath, requestPath: path }),
        };
        const response = await apiSocket.machineRPC<SessionCreateDirectoryResponse, SessionCreateDirectoryRequest>(
          machineTarget.machineId,
          RPC_METHODS.CREATE_DIRECTORY,
          request,
        );
        return assertRpcResponseWithSuccess<SessionCreateDirectoryResponse>(response);
      } catch (error) {
        if (!shouldFallbackToSessionRpc(sessionId, error)) {
          throw error;
        }
      }
    }

    if (!canUseSessionRpc(sessionId)) {
      return {
        success: false,
        error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      };
    }

    const request: SessionCreateDirectoryRequest = { path };
    const response = await apiSocket.sessionRPC<SessionCreateDirectoryResponse, SessionCreateDirectoryRequest>(
      sessionId,
      RPC_METHODS.CREATE_DIRECTORY,
      request,
    );
    return assertRpcResponseWithSuccess<SessionCreateDirectoryResponse>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    };
  }
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
  try {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (machineTarget) {
      try {
        const request: SessionListDirectoryRequest = {
          path: resolveMachinePathFromSessionBase({ basePath: machineTarget.basePath, requestPath: path }),
        };
        const response = await apiSocket.machineRPC<SessionListDirectoryResponse, SessionListDirectoryRequest>(
          machineTarget.machineId,
          RPC_METHODS.LIST_DIRECTORY,
          request,
        );
        return assertRpcResponseWithSuccess<SessionListDirectoryResponse>(response);
      } catch (error) {
        if (!shouldFallbackToSessionRpc(sessionId, error)) {
          throw error;
        }
      }
    }

    if (!canUseSessionRpc(sessionId)) {
      return {
        success: false,
        error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
      };
    }

    const request: SessionListDirectoryRequest = { path };
    const response = await apiSocket.sessionRPC<SessionListDirectoryResponse, SessionListDirectoryRequest>(
      sessionId,
      RPC_METHODS.LIST_DIRECTORY,
      request,
    );
    return assertRpcResponseWithSuccess<SessionListDirectoryResponse>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
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
  try {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (machineTarget) {
      try {
        const request: SessionGetDirectoryTreeRequest = {
          path: resolveMachinePathFromSessionBase({ basePath: machineTarget.basePath, requestPath: path }),
          maxDepth,
        };
        const response = await apiSocket.machineRPC<SessionGetDirectoryTreeResponse, SessionGetDirectoryTreeRequest>(
          machineTarget.machineId,
          RPC_METHODS.GET_DIRECTORY_TREE,
          request,
        );
        return assertRpcResponseWithSuccess<SessionGetDirectoryTreeResponse>(response);
      } catch (error) {
        if (!shouldFallbackToSessionRpc(sessionId, error)) {
          throw error;
        }
      }
    }

    if (!canUseSessionRpc(sessionId)) {
      return {
        success: false,
        error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
      };
    }

    const request: SessionGetDirectoryTreeRequest = { path, maxDepth };
    const response = await apiSocket.sessionRPC<SessionGetDirectoryTreeResponse, SessionGetDirectoryTreeRequest>(
      sessionId,
      RPC_METHODS.GET_DIRECTORY_TREE,
      request,
    );
    return assertRpcResponseWithSuccess<SessionGetDirectoryTreeResponse>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
