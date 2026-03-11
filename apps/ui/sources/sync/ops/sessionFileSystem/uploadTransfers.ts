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

type FilesUploadInitRequest = Readonly<{
  path: string;
  sizeBytes: number;
  overwrite?: boolean;
  sha256?: string;
}>;

export type FilesUploadInitResponse =
  | Readonly<{ success: true; uploadId: string; chunkSizeBytes: number }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionFilesUploadInit(
  sessionId: string,
  request: FilesUploadInitRequest,
): Promise<FilesUploadInitResponse> {
  try {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (machineTarget) {
      try {
        const machineRequest: FilesUploadInitRequest = {
          ...request,
          path: resolveMachinePathFromSessionBase({ basePath: machineTarget.basePath, requestPath: request.path }),
        };
        const response = await apiSocket.machineRPC<FilesUploadInitResponse, FilesUploadInitRequest>(
          machineTarget.machineId,
          RPC_METHODS.FILES_UPLOAD_INIT,
          machineRequest,
        );
        return assertRpcResponseWithSuccess<FilesUploadInitResponse>(response);
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

    const response = await apiSocket.sessionRPC<FilesUploadInitResponse, FilesUploadInitRequest>(
      sessionId,
      RPC_METHODS.FILES_UPLOAD_INIT,
      request,
    );
    return assertRpcResponseWithSuccess<FilesUploadInitResponse>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    };
  }
}

type FilesUploadChunkRequest = Readonly<{ uploadId: string; index: number; contentBase64: string }>;

export type FilesUploadChunkResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionFilesUploadChunk(
  sessionId: string,
  request: FilesUploadChunkRequest,
): Promise<FilesUploadChunkResponse> {
  try {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (machineTarget) {
      try {
        const response = await apiSocket.machineRPC<FilesUploadChunkResponse, FilesUploadChunkRequest>(
          machineTarget.machineId,
          RPC_METHODS.FILES_UPLOAD_CHUNK,
          request,
        );
        return assertRpcResponseWithSuccess<FilesUploadChunkResponse>(response);
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

    const response = await apiSocket.sessionRPC<FilesUploadChunkResponse, FilesUploadChunkRequest>(
      sessionId,
      RPC_METHODS.FILES_UPLOAD_CHUNK,
      request,
    );
    return assertRpcResponseWithSuccess<FilesUploadChunkResponse>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    };
  }
}

type FilesUploadFinalizeRequest = Readonly<{ uploadId: string }>;

export type FilesUploadFinalizeResponse =
  | Readonly<{ success: true; path: string; sizeBytes: number; sha256: string }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionFilesUploadFinalize(
  sessionId: string,
  request: FilesUploadFinalizeRequest,
): Promise<FilesUploadFinalizeResponse> {
  try {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (machineTarget) {
      try {
        const response = await apiSocket.machineRPC<FilesUploadFinalizeResponse, FilesUploadFinalizeRequest>(
          machineTarget.machineId,
          RPC_METHODS.FILES_UPLOAD_FINALIZE,
          request,
        );
        return assertRpcResponseWithSuccess<FilesUploadFinalizeResponse>(response);
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

    const response = await apiSocket.sessionRPC<FilesUploadFinalizeResponse, FilesUploadFinalizeRequest>(
      sessionId,
      RPC_METHODS.FILES_UPLOAD_FINALIZE,
      request,
    );
    return assertRpcResponseWithSuccess<FilesUploadFinalizeResponse>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    };
  }
}

type FilesUploadAbortRequest = Readonly<{ uploadId: string }>;

export type FilesUploadAbortResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionFilesUploadAbort(
  sessionId: string,
  request: FilesUploadAbortRequest,
): Promise<FilesUploadAbortResponse> {
  try {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (machineTarget) {
      const response = await apiSocket.machineRPC<FilesUploadAbortResponse, FilesUploadAbortRequest>(
        machineTarget.machineId,
        RPC_METHODS.FILES_UPLOAD_ABORT,
        request,
      );
      return assertRpcResponseWithSuccess<FilesUploadAbortResponse>(response);
    }

    if (!canUseSessionRpc(sessionId)) {
      return {
        success: false,
        error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      };
    }

    const response = await apiSocket.sessionRPC<FilesUploadAbortResponse, FilesUploadAbortRequest>(
      sessionId,
      RPC_METHODS.FILES_UPLOAD_ABORT,
      request,
    );
    return assertRpcResponseWithSuccess<FilesUploadAbortResponse>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    };
  }
}
