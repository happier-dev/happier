import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { encodeBase64 } from '@/encryption/base64';
import { downloadBulkPayloadToFile } from '@/sync/domains/transfers/runtime/bulkTransferPipeline';
import { mergeTransferChunks } from '@/sync/domains/transfers/runtime/mergeTransferChunks';
import { assertRpcResponseWithSuccess } from '@/sync/runtime/assertRpcResponseWithSuccess';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { canUseSessionRpc, readMachineTargetForSession } from '@/sync/ops/sessionMachineTarget';

import { readRpcErrorCode } from '../../runtime/rpcErrors';
import {
    INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
    callSessionMachineRpcWithFallback,
  createSessionMachineRpcFallbackCaller,
  rebasePathRequestToMachineTarget,
  resolveDefaultSessionRpcFallbackRoute,
} from '../../runtime/sessionMachineRpcFallback';

const SESSION_FILES_DOWNLOAD_INIT = 'daemon.sessionFiles.download.init';
const SESSION_FILES_DOWNLOAD_CHUNK = 'daemon.sessionFiles.download.chunk';
const SESSION_FILES_DOWNLOAD_FINALIZE = 'daemon.sessionFiles.download.finalize';
const SESSION_FILES_DOWNLOAD_ABORT = 'daemon.sessionFiles.download.abort';

type SessionReadFileRequest = Readonly<{ path: string }>;

type SessionFileDownloadInitResponse = Readonly<{
  success: true;
  downloadId: string;
  chunkSizeBytes: number;
  sizeBytes: number;
  name: string;
}> | Readonly<{ success: false; error: string; errorCode?: string }>;

type SessionFileDownloadChunkResponse = Readonly<{
  success: true;
  payloadBase64?: string;
  encryptedDataKeyEnvelopeBase64?: string;
  contentBase64?: string;
  isLast: boolean;
}> | Readonly<{ success: false; error: string; errorCode?: string }>;

export type SessionReadFileResponse =
  | Readonly<{ success: true; content: string }>
  | Readonly<{ success: false; error: string }>;

export async function sessionReadFile(sessionId: string, path: string): Promise<SessionReadFileResponse> {
  if (!readMachineTargetForSession(sessionId) && !canUseSessionRpc(sessionId)) {
    return {
      success: false,
      error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
    };
  }

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
      const chunks: Uint8Array[] = [];
      const download = await downloadBulkPayloadToFile({
        destination: {
          writeBytes: async (bytes) => {
            chunks.push(new Uint8Array(bytes));
          },
          close: async () => {},
          cleanup: async () => {
            chunks.length = 0;
          },
        },
        init: async (request) => await assertRpcResponseWithSuccess<SessionFileDownloadInitResponse>(await sessionRpcWithServerScope({
          sessionId: activeSessionId,
          serverId: route.serverId,
          method: SESSION_FILES_DOWNLOAD_INIT,
          payload: {
            path: readRequest.path,
            recipientPublicKeyBase64: request.recipientPublicKeyBase64,
          },
        })) as SessionFileDownloadInitResponse,
        readChunk: async (request) => await assertRpcResponseWithSuccess<SessionFileDownloadChunkResponse>(await sessionRpcWithServerScope({
          sessionId: activeSessionId,
          serverId: route.serverId,
          method: SESSION_FILES_DOWNLOAD_CHUNK,
          payload: request,
        })) as SessionFileDownloadChunkResponse,
        finalize: async (request) => await assertRpcResponseWithSuccess(await sessionRpcWithServerScope({
          sessionId: activeSessionId,
          serverId: route.serverId,
          method: SESSION_FILES_DOWNLOAD_FINALIZE,
          payload: request,
        })),
        abort: async (request) => await assertRpcResponseWithSuccess(await sessionRpcWithServerScope({
          sessionId: activeSessionId,
          serverId: route.serverId,
          method: SESSION_FILES_DOWNLOAD_ABORT,
          payload: request,
        })),
      });
      if (!download.ok) {
        return {
          success: false,
          error: download.error,
        } as unknown as TResponse;
      }
      return {
        success: true,
        content: encodeBase64(mergeTransferChunks(chunks), 'base64'),
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
