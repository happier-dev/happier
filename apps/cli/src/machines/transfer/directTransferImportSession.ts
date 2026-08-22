import { createTransferRecipientKeyPair } from './transferChunkEncryption';
import { clampTransferChunkBytes } from './transferChunkSizeLimit';
import {
  abortUploadTransferSession,
  createTransferSessionLifecycle,
  finalizeUploadTransferSession,
  openUploadTransferSession,
  writeUploadTransferChunk,
  type TransferSessionLifecycle,
} from '@/transfers/core/transferSessionLifecycle';
import { TransferSessionStore } from '@/transfers/core/transferSessionStore';
import type { TransferPathAllowanceRegistry } from '@/transfers/targets/createTransferPathAllowanceRegistry';
import type { ComposerMediaStageUploadTargetDeps } from '@/transfers/targets/resolveComposerMediaStageUploadTarget';
import {
  resolveTransferUploadInitTarget,
  type TransferUploadInitPromptAssetDeps,
  type TransferUploadInitRequest,
} from '@/transfers/targets/resolveTransferUploadInitTarget';
import type { WorkspaceFinalizeFileOperationsFactory } from '@/transfers/targets/resolveWorkspaceFileUploadTarget';
import { configuration } from '@/configuration';
import { randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';

export type DirectTransferImportOpenRequest = Readonly<{
  workingDirectory: string;
  additionalAllowedWriteDirs?: readonly string[];
  sessionRpcTransferMaxBytes?: number | null;
}> & TransferUploadInitRequest;

export type DirectTransferImportOpenResponse = Readonly<{
  uploadId: string;
  destDisplayPath: string;
  expectedSizeBytes: number;
  chunkSizeBytes: number;
  recipientPublicKeyBase64: string;
  expiresAt: number;
}>;

export type DirectTransferImportSessionManager = Readonly<{
  issueImportOpenAuthorizationToken: (input: DirectTransferImportOpenRequest) => Readonly<{
    authorizationToken: string;
    expiresAt: number;
  }>;
  openTrustedImportSession: (input: DirectTransferImportOpenRequest) => Promise<
    | Readonly<{ success: true; response: DirectTransferImportOpenResponse }>
    | Readonly<{ success: false; error: string }>
  >;
  openImportSession: (input: DirectTransferImportOpenRequest & Readonly<{
    authorizationToken: string;
  }>) => Promise<
    | Readonly<{ success: true; response: DirectTransferImportOpenResponse }>
    | Readonly<{ success: false; error: string }>
  >;
  writeImportTransferChunk: (input: Readonly<{
    uploadId: string;
    index: number;
    contentBase64?: string;
    payloadBase64?: string;
    encryptedDataKeyEnvelopeBase64?: string;
  }>) => Promise<Readonly<{ success: true } | { success: false; error: string }>>;
  finalizeImportTransferSession: (input: Readonly<{ uploadId: string }>) => Promise<
    Readonly<
      | { success: true; finalized: FinalizedImportTransferResult; sha256: string }
      | (Extract<
          Awaited<ReturnType<TransferSessionLifecycle['finalizeUploadTransferSession']>>,
          { success: false }
        > & Readonly<{ expiresAt?: number }>)
    >
  >;
  abortImportTransferSession: (
    input: Readonly<{ uploadId: string }>,
  ) => Promise<void | Readonly<{ aborted: boolean }>>;
  cleanupExpiredImportSessions: (now?: number) => void;
  getNextImportSessionExpiryAt: () => number | null;
  countActiveImportSessions: () => number;
  close: () => Promise<void>;
}>;

type FinalizedImportTransferResult = Extract<
  Awaited<ReturnType<TransferSessionLifecycle['finalizeUploadTransferSession']>>,
  { success: true }
>['finalized'];

type ImportOpenAuthorizationRecord = Readonly<{
  scopeFingerprint: string;
  expiresAt: number;
}>;

function fingerprintImportOpenAuthorizationScope(input: DirectTransferImportOpenRequest): string {
  return JSON.stringify({
    workingDirectory: input.workingDirectory,
    t: 't' in input ? input.t : 'session_file_upload_v1',
    ...('t' in input && input.t === 'composer_media_stage_upload_v1'
      ? {
          executionTarget: input.executionTarget ?? null,
          owner: input.owner ?? null,
          mediaKind: input.mediaKind ?? null,
          mimeType: input.mimeType ?? null,
          name: input.name ?? null,
          sizeBytes: input.sizeBytes ?? null,
          sha256: input.sha256 ?? null,
        }
      : ('t' in input && input.t === 'session_attachment_upload_v1'
      ? {
          messageLocalId: input.messageLocalId ?? null,
          fileName: input.fileName ?? null,
          sizeBytes: input.sizeBytes ?? null,
          uploadLocation: input.uploadLocation ?? null,
          workspaceRootPath: input.workspaceRootPath ?? null,
          workspaceRelativeDir: input.workspaceRelativeDir ?? null,
          vcsIgnoreStrategy: input.vcsIgnoreStrategy ?? null,
          vcsIgnoreWritesEnabled: input.vcsIgnoreWritesEnabled ?? null,
        }
      : ('t' in input && input.t === 'prompt_asset_upload_v1'
        ? {
            sizeBytes: input.sizeBytes ?? null,
          }
        : {
            path: input.path ?? null,
            sizeBytes: input.sizeBytes ?? null,
            overwrite: input.overwrite ?? null,
            sha256: input.sha256 ?? null,
          }))),
    additionalAllowedWriteDirs: input.additionalAllowedWriteDirs ? [...input.additionalAllowedWriteDirs] : null,
    sessionRpcTransferMaxBytes: input.sessionRpcTransferMaxBytes ?? null,
  });
}

export function createDirectTransferImportSessionManager(params?: Readonly<{
  ttlMs?: number;
  chunkSizeBytes?: number;
  accessPolicy?: FilesystemAccessPolicy;
  onActiveSessionCountChanged?: (count: number) => void;
  onActivity?: () => void;
  attachmentUpload?: Readonly<{
    pathAllowanceRegistry: TransferPathAllowanceRegistry;
  }>;
  composerMediaStage?: ComposerMediaStageUploadTargetDeps;
  promptAssetUpload?: TransferUploadInitPromptAssetDeps;
  finalizeFileOperations?: WorkspaceFinalizeFileOperationsFactory;
}>): DirectTransferImportSessionManager {
  const store = new TransferSessionStore({
    ttlMs: params?.ttlMs ?? configuration.filesTransferSessionTtlMs,
  });
  const attachmentTempUploadRoot = join(tmpdir(), 'happier', 'uploads', randomUUID());
  const lifecycle = createTransferSessionLifecycle({
    store,
    chunkSizeBytes: clampTransferChunkBytes(
      params?.chunkSizeBytes ?? configuration.filesTransferChunkBytes,
    ),
  });
  const authorizationTtlMs = params?.ttlMs ?? configuration.filesTransferSessionTtlMs;
  const importOpenAuthorizations = new Map<string, ImportOpenAuthorizationRecord>();
  const activeImportSessionIds = new Set<string>();
  let closePromise: Promise<void> | null = null;

  const publishActiveSessionCount = (): void => {
    if (!params?.onActiveSessionCountChanged) {
      return;
    }
    try {
      params.onActiveSessionCountChanged(activeImportSessionIds.size);
    } catch {
      // Best-effort only; observer failures must never break transfer finalization.
    }
  };

  const emitActivity = (): void => {
    if (!params?.onActivity) {
      return;
    }
    try {
      params.onActivity();
    } catch {
      // Best-effort only; observer failures must never break transfer finalization.
    }
  };

  const trackActiveImportSession = (uploadId: string): void => {
    activeImportSessionIds.add(uploadId);
    publishActiveSessionCount();
  };

  const untrackActiveImportSession = (uploadId: string): void => {
    if (!activeImportSessionIds.delete(uploadId)) {
      return;
    }
    publishActiveSessionCount();
  };

  const cleanupExpiredImportOpenAuthorizations = (now = Date.now()): void => {
    for (const [authorizationToken, authorization] of importOpenAuthorizations) {
      if (authorization.expiresAt > now) continue;
      importOpenAuthorizations.delete(authorizationToken);
    }
  };

  const issueImportOpenAuthorizationToken = (input: DirectTransferImportOpenRequest): Readonly<{
    authorizationToken: string;
    expiresAt: number;
  }> => {
    cleanupExpiredImportOpenAuthorizations();
    const authorizationToken = randomBytes(24).toString('base64url');
    const expiresAt = Date.now() + authorizationTtlMs;
    importOpenAuthorizations.set(authorizationToken, {
      scopeFingerprint: fingerprintImportOpenAuthorizationScope(input),
      expiresAt,
    });
    return {
      authorizationToken,
      expiresAt,
    };
  };

  const consumeImportOpenAuthorizationToken = (input: Readonly<{
    authorizationToken: string;
    authorizationScopeFingerprint: string;
  }>): boolean => {
    cleanupExpiredImportOpenAuthorizations();
    const authorization = importOpenAuthorizations.get(input.authorizationToken);
    if (!authorization) {
      return false;
    }
    importOpenAuthorizations.delete(input.authorizationToken);
    return authorization.scopeFingerprint === input.authorizationScopeFingerprint;
  };

  const openResolvedImportSession = async (
    input: DirectTransferImportOpenRequest,
  ): Promise<
    | Readonly<{ success: true; response: DirectTransferImportOpenResponse }>
    | Readonly<{ success: false; error: string }>
  > => {
    store.cleanupExpiredBestEffort();
    const {
      workingDirectory,
      additionalAllowedWriteDirs,
      sessionRpcTransferMaxBytes,
      authorizationToken: _authorizationToken,
      ...transferRequest
    } = input as DirectTransferImportOpenRequest & Readonly<{ authorizationToken?: unknown }>;
    void _authorizationToken;
    const resolvedTarget = await resolveTransferUploadInitTarget({
      workingDirectory,
      accessPolicy: params?.accessPolicy,
      request: transferRequest as TransferUploadInitRequest,
      tempUploadRoot: attachmentTempUploadRoot,
      additionalAllowedWriteDirs,
      sessionRpcTransferMaxBytes,
      ...(params?.attachmentUpload ? { attachmentUpload: params.attachmentUpload } : {}),
      ...(params?.composerMediaStage ? { composerMediaStage: params.composerMediaStage } : {}),
      ...(params?.promptAssetUpload ? { promptAssetUpload: params.promptAssetUpload } : {}),
      ...(params?.finalizeFileOperations
        ? { finalizeFileOperations: params.finalizeFileOperations }
        : {}),
    });

    if (!resolvedTarget.success) {
      return { success: false as const, error: resolvedTarget.error };
    }

    const recipientKeyPair = createTransferRecipientKeyPair();
    const session = await openUploadTransferSession<unknown>({
      lifecycle,
      target: resolvedTarget.target,
      sha256Expected: resolvedTarget.sha256Expected,
      recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
      recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
    });
    trackActiveImportSession(session.uploadId);
    emitActivity();

    return {
      success: true as const,
      response: {
        uploadId: session.uploadId,
        destDisplayPath: resolvedTarget.target.destDisplayPath,
        expectedSizeBytes: resolvedTarget.target.expectedSizeBytes,
        chunkSizeBytes: session.chunkSizeBytes,
        recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
        expiresAt: session.expiresAt,
      },
    };
  };

  return {
    issueImportOpenAuthorizationToken,

    openTrustedImportSession: async (input) => await openResolvedImportSession(input),

    async openImportSession(input) {
      const authorizationToken = input.authorizationToken?.trim() ?? '';
      if (!authorizationToken) {
        return { success: false as const, error: 'Import session open authorization required' };
      }
      const authorized = consumeImportOpenAuthorizationToken({
        authorizationToken,
        authorizationScopeFingerprint: fingerprintImportOpenAuthorizationScope(input),
      });
      if (!authorized) {
        return { success: false as const, error: 'Import session open authorization required' };
      }
      return await openResolvedImportSession(input);
    },

    async writeImportTransferChunk(input) {
      try {
        return await writeUploadTransferChunk({
          lifecycle,
          uploadId: input.uploadId,
          index: input.index,
          contentBase64: input.contentBase64,
          payloadBase64: input.payloadBase64,
          encryptedDataKeyEnvelopeBase64: input.encryptedDataKeyEnvelopeBase64,
        });
      } finally {
        emitActivity();
      }
    },

    async finalizeImportTransferSession(input) {
      try {
        const result = await finalizeUploadTransferSession({
          lifecycle,
          uploadId: input.uploadId,
        });
        if (result.success || result.keepSession !== true) {
          untrackActiveImportSession(input.uploadId);
        }
        if (!result.success && result.keepSession === true) {
          const retainedSession = store.getUploadSession(input.uploadId);
          if (retainedSession) {
            return {
              ...result,
              expiresAt: retainedSession.expiresAt,
            };
          }
        }
        return result;
      } finally {
        emitActivity();
      }
    },

    async abortImportTransferSession(input) {
      try {
        const result = await abortUploadTransferSession({
          lifecycle,
          uploadId: input.uploadId,
        });
        untrackActiveImportSession(input.uploadId);
        return result;
      } finally {
        emitActivity();
      }
    },

    cleanupExpiredImportSessions(now = Date.now()) {
      store.cleanupExpiredBestEffort(now);
      for (const uploadId of [...activeImportSessionIds]) {
        if (store.getUploadSession(uploadId)) {
          continue;
        }
        activeImportSessionIds.delete(uploadId);
      }
      publishActiveSessionCount();
    },

    getNextImportSessionExpiryAt() {
      return store.getNextExpiryAt();
    },

    countActiveImportSessions() {
      return activeImportSessionIds.size;
    },

    async close() {
      if (closePromise) {
        return await closePromise;
      }

      closePromise = (async () => {
        importOpenAuthorizations.clear();
        activeImportSessionIds.clear();
        publishActiveSessionCount();
        await store.dispose();
      })();

      return await closePromise;
    },
  };
}
