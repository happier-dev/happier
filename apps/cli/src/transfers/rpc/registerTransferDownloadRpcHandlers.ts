import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import { parseTransferRecipientPublicKeyBase64 } from '@happier-dev/transfers/node';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SessionAttachmentDownloadInitRequestV1Schema } from '@happier-dev/protocol/transfers/sessions/sessionAttachmentHandleV1';
import type { SessionAttachmentDownloadInitRequestV1 } from '@happier-dev/protocol';

import { TransferSessionStore } from '@happier-dev/transfers/node';
import {
  resolveComposerMediaStageDownloadSource,
  type ComposerMediaStageDownloadInitRequest,
  type ComposerMediaStageDownloadSourceDeps,
} from '../targets/resolveComposerMediaStageDownloadSource';
import { resolveWorkspaceFileDownloadSource } from '../targets/resolveWorkspaceFileDownloadSource';
import { registerDownloadTransferLifecycleHandlers } from './registerDownloadTransferLifecycleHandlers';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import type { ExactAllowedReadFile } from '@/rpc/handlers/fileSystem/accessPolicy/exactAllowedReadFile';

type SessionFileDownloadInitRequest = Readonly<{
  t: 'session_file_download_v1';
  path: string;
  asZip?: boolean;
  recipientPublicKeyBase64?: string;
}>;
type TransferDownloadInitRequest = SessionFileDownloadInitRequest | ComposerMediaStageDownloadInitRequest | SessionAttachmentDownloadInitRequestV1;

type TransferDownloadInitResponse =
  | Readonly<{ success: true; downloadId: string; chunkSizeBytes: number; sizeBytes: number; name: string }>
  | Readonly<{ success: false; error: string }>;

export function registerTransferDownloadRpcHandlers(
  rpcHandlerManager: RpcHandlerRegistrar,
  deps: Readonly<{
    workingDirectory: string;
    accessPolicy?: FilesystemAccessPolicy;
    store: TransferSessionStore;
    getAdditionalAllowedReadDirs?: () => ReadonlyArray<string>;
    getAdditionalAllowedReadFiles?: () => ReadonlyArray<ExactAllowedReadFile>;
    sessionRpcTransferMaxBytes?: number | null;
    composerMediaStage?: ComposerMediaStageDownloadSourceDeps;
    sessionAttachment?: Readonly<{ sessionId: string }>;
  }>,
): void {
  registerDownloadTransferLifecycleHandlers<TransferDownloadInitResponse>({
    rpcHandlerManager,
    store: deps.store,
    methods: {
      init: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT,
      chunk: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK,
      finalize: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE,
      abort: RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT,
    },
    resolveInit: async (data) => {
      const request = data as TransferDownloadInitRequest | null;
      if (deps.sessionAttachment) {
        const parsed = SessionAttachmentDownloadInitRequestV1Schema.safeParse(data);
        const issued = parsed.success && parsed.data.attachmentHandle.sessionId === deps.sessionAttachment.sessionId
          ? deps.store.getIssuedAttachment(parsed.data.attachmentHandle)
          : null;
        if (!parsed.success || !issued) {
          return { kind: 'rejected', response: { success: false, error: 'Session attachment handle is unavailable' } };
        }
        try {
          parseTransferRecipientPublicKeyBase64(parsed.data.recipientPublicKeyBase64);
        } catch {
          return { kind: 'rejected', response: { success: false, error: 'Invalid recipientPublicKeyBase64' } };
        }
        const source = await resolveWorkspaceFileDownloadSource({
          workingDirectory: deps.workingDirectory,
          accessPolicy: deps.accessPolicy,
          path: issued.filePath,
          asZip: false,
          additionalAllowedReadDirs: deps.getAdditionalAllowedReadDirs?.(),
          sessionRpcTransferMaxBytes: deps.sessionRpcTransferMaxBytes ?? null,
        });
        if (!source.success) return { kind: 'rejected', response: source };
        return {
          kind: 'accepted',
          source: { ...source.source, name: issued.name },
          recipientPublicKeyBase64: parsed.data.recipientPublicKeyBase64,
          diagnosticContext: { transferKind: 'session_attachment' },
        };
      }
      if (!request || (request.t !== 'session_file_download_v1' && request.t !== 'composer_media_stage_inspect_v1')) {
        return {
          kind: 'rejected',
          response: {
            success: false,
            error: 'Invalid request',
          },
        };
      }

      const recipientPublicKeyBase64 = typeof request.recipientPublicKeyBase64 === 'string'
        ? request.recipientPublicKeyBase64.trim()
        : '';
      if (!recipientPublicKeyBase64) {
        return {
          kind: 'rejected',
          response: {
            success: false,
            error: 'Missing recipientPublicKeyBase64',
          },
        };
      }
      try {
        // Validate early so init fails closed instead of crashing later during chunk encryption.
        parseTransferRecipientPublicKeyBase64(recipientPublicKeyBase64);
      } catch (error) {
        return {
          kind: 'rejected',
          response: {
            success: false,
            error: error instanceof Error ? error.message : 'Invalid recipientPublicKeyBase64',
          },
        };
      }
      const source = request.t === 'composer_media_stage_inspect_v1'
        ? deps.composerMediaStage
          ? await resolveComposerMediaStageDownloadSource({
              request,
              deps: deps.composerMediaStage,
              sessionRpcTransferMaxBytes: deps.sessionRpcTransferMaxBytes ?? null,
            })
          : { success: false as const, error: 'Composer media staging is unavailable' }
        : await resolveWorkspaceFileDownloadSource({
            workingDirectory: deps.workingDirectory,
            accessPolicy: deps.accessPolicy,
            path: request.path,
            asZip: request.asZip,
            additionalAllowedReadDirs: deps.getAdditionalAllowedReadDirs?.(),
            additionalAllowedReadFiles: deps.getAdditionalAllowedReadFiles?.(),
            sessionRpcTransferMaxBytes: deps.sessionRpcTransferMaxBytes ?? null,
          });
      if (!source.success) {
        return { kind: 'rejected', response: source };
      }
      return {
        kind: 'accepted',
        source: source.source,
        recipientPublicKeyBase64,
        diagnosticContext: {
          transferKind: request.t === 'composer_media_stage_inspect_v1'
            ? 'composer_media_stage'
            : 'session_file',
          ...(request.t === 'session_file_download_v1'
            ? { archiveRequested: Boolean(request.asZip) }
            : {}),
        },
      };
    },
    buildInitSuccessResponse: ({ session, source }) => ({
      success: true,
      downloadId: session.downloadId,
      chunkSizeBytes: session.chunkSizeBytes,
      sizeBytes: source.sizeBytes,
      name: source.name,
    }),
    buildInitErrorResponse: (error) => ({ success: false, error: error instanceof Error ? error.message : 'Download init failed' }),
  });
}
