import { createTransferRecipientKeyPair } from '@happier-dev/transfers/node';
import { clampTransferChunkBytes } from '@happier-dev/transfers/node';
import {
  abortUploadTransferSession,
  createTransferSessionLifecycle,
  finalizeUploadTransferSession,
  openUploadTransferSession,
  writeUploadTransferChunk,
  type TransferSessionLifecycle,
} from '@happier-dev/transfers/node';
import { TransferSessionStore } from '@happier-dev/transfers/node';
import type { ComposerMediaStageUploadTargetDeps } from '@/transfers/targets/resolveComposerMediaStageUploadTarget';
import {
  resolveTransferUploadInitTarget,
  type TransferUploadInitPromptAssetDeps,
  type TransferUploadInitRequest,
  type TransferUploadInitAttachmentDeps,
} from '@/transfers/targets/resolveTransferUploadInitTarget';
import type { WorkspaceFinalizeFileOperationsFactory } from '@/transfers/targets/resolveWorkspaceFileUploadTarget';
import { configuration } from '@/configuration';
import { randomBytes } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyFile, rename, rm } from 'node:fs/promises';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { assertPreparedFilesystemTransferScope, type PreparedFilesystemTransferScope } from './preparedFilesystemTransferScope';
import type { LiveWorkProducerV1, LiveWorkInventoryV1, LiveWorkItemV1 } from '@/daemon/lifecycle/managedActivity';
import type { DaemonAdmissionDrain } from '@/daemon/lifecycle/admissionDrain';

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

export type PreparedImportTransferSettlement = Readonly<
  | { success: true; finalized: FinalizedImportTransferResult; sha256: string }
  | { success: false; error: string; errorCode?: string }
>;

export type DirectTransferImportSessionManager = Readonly<{
  activity: LiveWorkProducerV1;
  issueImportOpenAuthorizationToken: (input: DirectTransferImportOpenRequest) => Readonly<{
    authorizationToken: string;
    expiresAt: number;
  }>;
  openTrustedImportSession: (input: DirectTransferImportOpenRequest, filesystemScope?: PreparedFilesystemTransferScope, privateStagingDirectory?: string) => Promise<
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
    filesystemScope?: PreparedFilesystemTransferScope | null,
  ) => Promise<void | Readonly<{ aborted: boolean }>>;
  waitForImportTransferSettlement: (uploadId: string, filesystemScope: PreparedFilesystemTransferScope) => Promise<PreparedImportTransferSettlement>;
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
          sessionId: input.sessionId,
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
  admissionDrain?: Pick<DaemonAdmissionDrain, 'isQuiescing' | 'isFinalShutdown'>;
  ttlMs?: number;
  chunkSizeBytes?: number;
  accessPolicy?: FilesystemAccessPolicy;
  onActiveSessionCountChanged?: (count: number) => void;
  onActivity?: () => void;
  attachmentUpload?: TransferUploadInitAttachmentDeps;
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
  const activeImportSessionIds = new Map<string | Promise<unknown>, Readonly<{
    filesystemScope?: PreparedFilesystemTransferScope;
    settlement: Promise<PreparedImportTransferSettlement>;
    settle: (result: PreparedImportTransferSettlement) => void;
  }>>();
  const activityListeners = new Set<() => void>();
  let closePromise: Promise<void> | null = null;
  const assertCurrentFilesystemOwner = async (scope: PreparedFilesystemTransferScope): Promise<void> => {
    if (closePromise) throw new Error('The prepared import owner is stopped');
    await scope.assertCurrentAuthority?.();
    if (closePromise) throw new Error('The prepared import owner is stopped');
  };
  const activeSessionCount = (): number => [...activeImportSessionIds.keys()].filter(key => typeof key === 'string').length;

  const publishActiveSessionCount = (): void => {
    for (const listener of activityListeners) {
      try { listener(); } catch { /* Observation cannot alter upload custody. */ }
    }
    if (!params?.onActiveSessionCountChanged) {
      return;
    }
    try {
      params.onActiveSessionCountChanged(activeSessionCount());
    } catch {
      // Best-effort only; observer failures must never break transfer finalization.
    }
  };

  const emitActivity = (): void => {
    for (const listener of activityListeners) {
      try { listener(); } catch { /* Observation cannot alter upload custody. */ }
    }
    if (!params?.onActivity) {
      return;
    }
    try {
      params.onActivity();
    } catch {
      // Best-effort only; observer failures must never break transfer finalization.
    }
  };

  const trackActiveImportSession = (uploadId: string | Promise<unknown>, filesystemScope?: PreparedFilesystemTransferScope): void => {
    let settle!: (result: PreparedImportTransferSettlement) => void;
    const settlement = new Promise<PreparedImportTransferSettlement>((resolve) => { settle = resolve; });
    activeImportSessionIds.set(uploadId, { ...(filesystemScope ? { filesystemScope } : {}), settlement, settle });
    if (typeof uploadId === 'string') publishActiveSessionCount(); else emitActivity();
  };

  const untrackActiveImportSession = (uploadId: string | Promise<unknown>): void => {
    if (!activeImportSessionIds.delete(uploadId)) {
      return;
    }
    if (typeof uploadId === 'string') publishActiveSessionCount(); else emitActivity();
  };

  const cleanupExpiredImportOpenAuthorizations = (now = Date.now()): void => {
    for (const [authorizationToken, authorization] of importOpenAuthorizations) {
      if (authorization.expiresAt > now) continue;
      importOpenAuthorizations.delete(authorizationToken);
    }
  };

  const cleanupExpiredImportSessions = (now = Date.now()): void => {
    const previousCount = activeSessionCount();
    store.cleanupExpiredBestEffort(now);
    for (const [uploadId, active] of activeImportSessionIds) {
      if (typeof uploadId !== 'string') continue;
      if (store.getUploadSession(uploadId)) continue;
      active.settle({ success: false, error: 'Prepared import transfer expired', errorCode: 'indeterminate' });
      activeImportSessionIds.delete(uploadId);
    }
    if (activeSessionCount() !== previousCount) publishActiveSessionCount();
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

  const prepareImportSession = async (
    input: DirectTransferImportOpenRequest,
    filesystemScope?: PreparedFilesystemTransferScope,
    privateStagingDirectory?: string,
  ): Promise<
    | Readonly<{ success: true; response: DirectTransferImportOpenResponse }>
    | Readonly<{ success: false; error: string }>
  > => {
    cleanupExpiredImportSessions();
    const {
      workingDirectory,
      additionalAllowedWriteDirs,
      sessionRpcTransferMaxBytes,
      authorizationToken: _authorizationToken,
      ...transferRequest
    } = input as DirectTransferImportOpenRequest & Readonly<{ authorizationToken?: unknown }>;
    void _authorizationToken;
    const finalizeFileOperations: WorkspaceFinalizeFileOperationsFactory | undefined = filesystemScope
      ? input => {
        const operations = params?.finalizeFileOperations?.(input);
        let commitAdmitted = false;
        const admitCommit = async () => {
          if (commitAdmitted) return;
          await assertCurrentFilesystemOwner(filesystemScope);
          commitAdmitted = true;
        };
        return {
          copyFile: async (source, destination, mode) => {
            await admitCommit();
            await (operations?.copyFile ?? copyFile)(source, destination, mode);
          },
          rename: async (source, destination) => {
            await admitCommit();
            await (operations?.rename ?? rename)(source, destination);
          },
          // Once commit is admitted, incumbent cleanup/rollback must remain
          // able to settle; revocation cannot prevent destination restoration.
          rm: operations?.rm ?? rm,
        };
      } : params?.finalizeFileOperations;
    const resolvedTarget = await resolveTransferUploadInitTarget({
      workingDirectory,
      accessPolicy: privateStagingDirectory ? { kind: 'restrictedRoots', roots: [privateStagingDirectory] } : params?.accessPolicy,
      request: transferRequest as TransferUploadInitRequest,
      tempUploadRoot: attachmentTempUploadRoot,
      additionalAllowedWriteDirs,
      sessionRpcTransferMaxBytes,
      ...(params?.attachmentUpload ? { attachmentUpload: params.attachmentUpload } : {}),
      ...(params?.composerMediaStage ? { composerMediaStage: params.composerMediaStage } : {}),
      ...(params?.promptAssetUpload ? { promptAssetUpload: params.promptAssetUpload } : {}),
      ...(finalizeFileOperations
        ? { finalizeFileOperations }
        : {}),
    });

    if (!resolvedTarget.success) {
      return { success: false as const, error: resolvedTarget.error };
    }

    const recipientKeyPair = createTransferRecipientKeyPair();
    const session = await openUploadTransferSession<unknown>({
      lifecycle,
      target: filesystemScope ? { ...resolvedTarget.target, finalizeUpload: async input => {
        await assertCurrentFilesystemOwner(filesystemScope);
        return await resolvedTarget.target.finalizeUpload(input);
      } } : resolvedTarget.target,
      sha256Expected: resolvedTarget.sha256Expected,
      recipientSecretKeySeed: recipientKeyPair.recipientSecretKeySeed,
      recipientPublicKeyBase64: recipientKeyPair.recipientPublicKeyBase64,
    });
    trackActiveImportSession(session.uploadId, filesystemScope);
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

  const openResolvedImportSession = async (input: DirectTransferImportOpenRequest, filesystemScope?: PreparedFilesystemTransferScope, privateStagingDirectory?: string) => {
    if (closePromise) return { success: false as const, error: 'Import transfer owner is stopped' };
    const preparation = prepareImportSession(input, filesystemScope, privateStagingDirectory);
    trackActiveImportSession(preparation, filesystemScope);
    try { return await preparation; }
    finally { untrackActiveImportSession(preparation); }
  };
  const activity: LiveWorkProducerV1 = Object.freeze({
    read(): Omit<LiveWorkInventoryV1, 'idleSince'> {
      const items: LiveWorkItemV1[] = [...activeImportSessionIds.keys()].map(ownerRef => ({
        category: 'transfer', ownerRef, attribution: { kind: 'unknown' }, state: 'active',
      }));
      return { items, coverage: 'complete' };
    },
    subscribe(listener: () => void): () => void {
      activityListeners.add(listener);
      return () => { activityListeners.delete(listener); };
    },
  });
  return {
    activity,
    issueImportOpenAuthorizationToken,

    openTrustedImportSession: async (input, filesystemScope, privateStagingDirectory) => await openResolvedImportSession(input, filesystemScope, privateStagingDirectory),

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
      // An issued authorization is not an admitted upload. Existing upload IDs
      // retain their byte, finalization, and cleanup custody through a drain.
      if (params?.admissionDrain?.isQuiescing()) {
        return { success: false as const, error: params.admissionDrain.isFinalShutdown()
          ? 'The daemon is shutting down.' : 'The daemon is draining.' };
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
        activeImportSessionIds.get(input.uploadId)?.settle(result);
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

    async abortImportTransferSession(input, filesystemScope) {
      if (!activeImportSessionIds.has(input.uploadId)) return { aborted: false };
      assertPreparedFilesystemTransferScope(activeImportSessionIds.get(input.uploadId)?.filesystemScope, filesystemScope);
      try {
        const result = await abortUploadTransferSession({
          lifecycle,
          uploadId: input.uploadId,
        });
        activeImportSessionIds.get(input.uploadId)?.settle({ success: false, error: 'Upload cancelled', errorCode: 'cancelled' });
        untrackActiveImportSession(input.uploadId);
        return result;
      } finally {
        emitActivity();
      }
    },

    async waitForImportTransferSettlement(uploadId, filesystemScope) {
      const active = activeImportSessionIds.get(uploadId);
      if (!active) return { success: false, error: 'Prepared import transfer is unavailable', errorCode: 'indeterminate' };
      assertPreparedFilesystemTransferScope(active.filesystemScope, filesystemScope);
      return await active.settlement;
    },

    cleanupExpiredImportSessions,

    getNextImportSessionExpiryAt() {
      return store.getNextExpiryAt();
    },

    countActiveImportSessions() {
      return activeSessionCount();
    },

    async close() {
      if (closePromise) {
        return await closePromise;
      }

      closePromise = (async () => {
        importOpenAuthorizations.clear();
        await Promise.allSettled([...activeImportSessionIds.keys()].filter((key): key is Promise<unknown> => typeof key !== 'string'));
        for (const active of activeImportSessionIds.values()) {
          active.settle({ success: false, error: 'Prepared import transfer owner stopped', errorCode: 'indeterminate' });
        }
        activeImportSessionIds.clear();
        const disposal = store.dispose();
        trackActiveImportSession(disposal);
        publishActiveSessionCount();
        try { await disposal; }
        finally { untrackActiveImportSession(disposal); }
      })();

      return await closePromise;
    },
  };
}
