import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { encodeBase64 } from '@/encryption/base64';

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

type SessionReadFileRequest = Readonly<{ path: string }>;

export type SessionReadFileResponse =
  | Readonly<{ success: true; content: string }>
  | Readonly<{ success: false; error: string }>;

export async function sessionReadFile(sessionId: string, path: string): Promise<SessionReadFileResponse> {
  try {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (machineTarget) {
      try {
        const request: SessionReadFileRequest = {
          path: resolveMachinePathFromSessionBase({ basePath: machineTarget.basePath, requestPath: path }),
        };
        const response = await apiSocket.machineRPC<SessionReadFileResponse, SessionReadFileRequest>(
          machineTarget.machineId,
          RPC_METHODS.READ_FILE,
          request,
        );
        return assertRpcResponseWithSuccess<SessionReadFileResponse>(response);
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

    const request: SessionReadFileRequest = { path };
    const response = await apiSocket.sessionRPC<SessionReadFileResponse, SessionReadFileRequest>(
      sessionId,
      RPC_METHODS.READ_FILE,
      request,
    );
    return assertRpcResponseWithSuccess<SessionReadFileResponse>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
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
  try {
    const contentBase64 = encodeBase64(new TextEncoder().encode(content), 'base64');
    const request: SessionWriteFileRequest =
      expectedHash === undefined
        ? { path, content: contentBase64 }
        : { path, content: contentBase64, expectedHash };

    const machineTarget = readMachineTargetForSession(sessionId);
    if (machineTarget) {
      try {
        const machineRequest: SessionWriteFileRequest = {
          ...request,
          path: resolveMachinePathFromSessionBase({ basePath: machineTarget.basePath, requestPath: path }),
        };
        const response = await apiSocket.machineRPC<SessionWriteFileResponse, SessionWriteFileRequest>(
          machineTarget.machineId,
          RPC_METHODS.WRITE_FILE,
          machineRequest,
        );
        return assertRpcResponseWithSuccess<SessionWriteFileResponse>(response);
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

    const response = await apiSocket.sessionRPC<SessionWriteFileResponse, SessionWriteFileRequest>(
      sessionId,
      RPC_METHODS.WRITE_FILE,
      request,
    );
    return assertRpcResponseWithSuccess<SessionWriteFileResponse>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    };
  }
}
