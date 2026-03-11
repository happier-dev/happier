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
  try {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (machineTarget) {
      try {
        const request: SessionStatFileRequest = {
          path: resolveMachinePathFromSessionBase({ basePath: machineTarget.basePath, requestPath: path }),
        };
        const response = await apiSocket.machineRPC<SessionStatFileResponse, SessionStatFileRequest>(
          machineTarget.machineId,
          RPC_METHODS.STAT_FILE,
          request,
        );
        return assertRpcResponseWithSuccess<SessionStatFileResponse>(response);
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

    const request: SessionStatFileRequest = { path };
    const response = await apiSocket.sessionRPC<SessionStatFileResponse, SessionStatFileRequest>(
      sessionId,
      RPC_METHODS.STAT_FILE,
      request,
    );
    return assertRpcResponseWithSuccess<SessionStatFileResponse>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    };
  }
}

type SessionRenamePathRequest = Readonly<{ from: string; to: string; overwrite?: boolean }>;

export type SessionRenamePathResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionRenamePath(
  sessionId: string,
  input: Readonly<{ from: string; to: string; overwrite?: boolean }>,
): Promise<SessionRenamePathResponse> {
  try {
    const request: SessionRenamePathRequest = {
      from: input.from,
      to: input.to,
      overwrite: input.overwrite,
    };

    const machineTarget = readMachineTargetForSession(sessionId);
    if (machineTarget) {
      try {
        const machineRequest: SessionRenamePathRequest = {
          ...request,
          from: resolveMachinePathFromSessionBase({ basePath: machineTarget.basePath, requestPath: input.from }),
          to: resolveMachinePathFromSessionBase({ basePath: machineTarget.basePath, requestPath: input.to }),
        };
        const response = await apiSocket.machineRPC<SessionRenamePathResponse, SessionRenamePathRequest>(
          machineTarget.machineId,
          RPC_METHODS.RENAME_PATH,
          machineRequest,
        );
        return assertRpcResponseWithSuccess<SessionRenamePathResponse>(response);
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

    const response = await apiSocket.sessionRPC<SessionRenamePathResponse, SessionRenamePathRequest>(
      sessionId,
      RPC_METHODS.RENAME_PATH,
      request,
    );
    return assertRpcResponseWithSuccess<SessionRenamePathResponse>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    };
  }
}

type SessionDeletePathRequest = Readonly<{ path: string; recursive?: boolean }>;

export type SessionDeletePathResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionDeletePath(
  sessionId: string,
  input: Readonly<{ path: string; recursive?: boolean }>,
): Promise<SessionDeletePathResponse> {
  try {
    const request: SessionDeletePathRequest = {
      path: input.path,
      recursive: input.recursive,
    };

    const machineTarget = readMachineTargetForSession(sessionId);
    if (machineTarget) {
      try {
        const machineRequest: SessionDeletePathRequest = {
          ...request,
          path: resolveMachinePathFromSessionBase({ basePath: machineTarget.basePath, requestPath: input.path }),
        };
        const response = await apiSocket.machineRPC<SessionDeletePathResponse, SessionDeletePathRequest>(
          machineTarget.machineId,
          RPC_METHODS.DELETE_PATH,
          machineRequest,
        );
        return assertRpcResponseWithSuccess<SessionDeletePathResponse>(response);
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

    const response = await apiSocket.sessionRPC<SessionDeletePathResponse, SessionDeletePathRequest>(
      sessionId,
      RPC_METHODS.DELETE_PATH,
      request,
    );
    return assertRpcResponseWithSuccess<SessionDeletePathResponse>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    };
  }
}
