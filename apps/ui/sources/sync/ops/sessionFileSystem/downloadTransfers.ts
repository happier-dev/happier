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

type FilesDownloadInitRequest = Readonly<{ path: string; asZip?: boolean }>;

export type FilesDownloadInitResponse =
  | Readonly<{ success: true; downloadId: string; chunkSizeBytes: number; sizeBytes: number; name: string }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionFilesDownloadInit(
  sessionId: string,
  request: FilesDownloadInitRequest,
): Promise<FilesDownloadInitResponse> {
  try {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (machineTarget) {
      try {
        const machineRequest: FilesDownloadInitRequest = {
          ...request,
          path: resolveMachinePathFromSessionBase({ basePath: machineTarget.basePath, requestPath: request.path }),
        };
        const response = await apiSocket.machineRPC<FilesDownloadInitResponse, FilesDownloadInitRequest>(
          machineTarget.machineId,
          RPC_METHODS.FILES_DOWNLOAD_INIT,
          machineRequest,
        );
        return assertRpcResponseWithSuccess<FilesDownloadInitResponse>(response);
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

    const response = await apiSocket.sessionRPC<FilesDownloadInitResponse, FilesDownloadInitRequest>(
      sessionId,
      RPC_METHODS.FILES_DOWNLOAD_INIT,
      request,
    );
    return assertRpcResponseWithSuccess<FilesDownloadInitResponse>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    };
  }
}

type FilesDownloadChunkRequest = Readonly<{ downloadId: string; index: number }>;

export type FilesDownloadChunkResponse =
  | Readonly<{ success: true; contentBase64: string; isLast: boolean }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionFilesDownloadChunk(
  sessionId: string,
  request: FilesDownloadChunkRequest,
): Promise<FilesDownloadChunkResponse> {
  try {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (machineTarget) {
      try {
        const response = await apiSocket.machineRPC<FilesDownloadChunkResponse, FilesDownloadChunkRequest>(
          machineTarget.machineId,
          RPC_METHODS.FILES_DOWNLOAD_CHUNK,
          request,
        );
        return assertRpcResponseWithSuccess<FilesDownloadChunkResponse>(response);
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

    const response = await apiSocket.sessionRPC<FilesDownloadChunkResponse, FilesDownloadChunkRequest>(
      sessionId,
      RPC_METHODS.FILES_DOWNLOAD_CHUNK,
      request,
    );
    return assertRpcResponseWithSuccess<FilesDownloadChunkResponse>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    };
  }
}

type FilesDownloadFinalizeRequest = Readonly<{ downloadId: string }>;

export type FilesDownloadFinalizeResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionFilesDownloadFinalize(
  sessionId: string,
  request: FilesDownloadFinalizeRequest,
): Promise<FilesDownloadFinalizeResponse> {
  try {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (machineTarget) {
      const response = await apiSocket.machineRPC<FilesDownloadFinalizeResponse, FilesDownloadFinalizeRequest>(
        machineTarget.machineId,
        RPC_METHODS.FILES_DOWNLOAD_FINALIZE,
        request,
      );
      return assertRpcResponseWithSuccess<FilesDownloadFinalizeResponse>(response);
    }

    if (!canUseSessionRpc(sessionId)) {
      return {
        success: false,
        error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      };
    }

    const response = await apiSocket.sessionRPC<FilesDownloadFinalizeResponse, FilesDownloadFinalizeRequest>(
      sessionId,
      RPC_METHODS.FILES_DOWNLOAD_FINALIZE,
      request,
    );
    return assertRpcResponseWithSuccess<FilesDownloadFinalizeResponse>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    };
  }
}

type FilesDownloadAbortRequest = Readonly<{ downloadId: string }>;

export type FilesDownloadAbortResponse =
  | Readonly<{ success: true }>
  | Readonly<{ success: false; error: string; errorCode?: string }>;

export async function sessionFilesDownloadAbort(
  sessionId: string,
  request: FilesDownloadAbortRequest,
): Promise<FilesDownloadAbortResponse> {
  try {
    const machineTarget = readMachineTargetForSession(sessionId);
    if (machineTarget) {
      const response = await apiSocket.machineRPC<FilesDownloadAbortResponse, FilesDownloadAbortRequest>(
        machineTarget.machineId,
        RPC_METHODS.FILES_DOWNLOAD_ABORT,
        request,
      );
      return assertRpcResponseWithSuccess<FilesDownloadAbortResponse>(response);
    }

    if (!canUseSessionRpc(sessionId)) {
      return {
        success: false,
        error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
      };
    }

    const response = await apiSocket.sessionRPC<FilesDownloadAbortResponse, FilesDownloadAbortRequest>(
      sessionId,
      RPC_METHODS.FILES_DOWNLOAD_ABORT,
      request,
    );
    return assertRpcResponseWithSuccess<FilesDownloadAbortResponse>(response);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
      errorCode: readRpcErrorCode(error),
    };
  }
}
