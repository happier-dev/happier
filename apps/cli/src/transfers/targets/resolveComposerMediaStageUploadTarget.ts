import {
  ComposerContentDisplayNameV1Schema,
  ComposerContentMediaKindV1Schema,
  ComposerContentMimeTypeV1Schema,
  PluginContributionIdentityV1Schema,
  SessionExecutionTargetV1Schema,
  type ComposerContentHandleV1,
  type ComposerContentMediaKindV1,
  type ComposerContentMimeTypeV1,
  type PluginContributionIdentityV1,
  type SessionExecutionTargetV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import {
  isServerRoutedTransferOverSizeLimit,
  SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR,
} from '@/transfers/policy/serverRoutedTransferPolicy';
import type { ComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';

import type { UploadTransferTarget } from './uploadTransferTarget';

export type ComposerMediaStageUploadInitRequest = Readonly<{
  t: 'composer_media_stage_upload_v1';
  executionTarget: unknown;
  owner: unknown;
  mediaKind: unknown;
  mimeType: unknown;
  name: unknown;
  sizeBytes: unknown;
  sha256: unknown;
}>;

export type ComposerMediaStageUploadTarget = UploadTransferTarget<ComposerContentHandleV1> & Readonly<{
  destPath: string;
}>;

export type ComposerMediaStageUploadTargetDeps = Readonly<{
  executionTarget: SessionExecutionTargetV1;
  store: ComposerMediaStageStore;
}>;

type ParsedComposerMediaStageUploadRequest = Readonly<{
  executionTarget: SessionExecutionTargetV1;
  owner: PluginContributionIdentityV1;
  mediaKind: ComposerContentMediaKindV1;
  mimeType: ComposerContentMimeTypeV1;
  name: string;
  sizeBytes: number;
  sha256: string;
}>;

type ResolveComposerMediaStageUploadTargetResult =
  | Readonly<{ success: true; target: ComposerMediaStageUploadTarget; sha256Expected: string }>
  | Readonly<{ success: false; error: string }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function sameExecutionTarget(left: SessionExecutionTargetV1, right: SessionExecutionTargetV1): boolean {
  return left.serverId === right.serverId && left.machineId === right.machineId;
}

function readRequest(value: ComposerMediaStageUploadInitRequest): ParsedComposerMediaStageUploadRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    't',
    'executionTarget',
    'owner',
    'mediaKind',
    'mimeType',
    'name',
    'sizeBytes',
    'sha256',
  ])) {
    return null;
  }
  if (value.t !== 'composer_media_stage_upload_v1') return null;
  const executionTarget = SessionExecutionTargetV1Schema.safeParse(value.executionTarget);
  const owner = PluginContributionIdentityV1Schema.safeParse(value.owner);
  const mediaKind = ComposerContentMediaKindV1Schema.safeParse(value.mediaKind);
  const mimeType = ComposerContentMimeTypeV1Schema.safeParse(value.mimeType);
  const name = ComposerContentDisplayNameV1Schema.safeParse(value.name);
  const sizeBytes = typeof value.sizeBytes === 'number' && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes > 0
    ? value.sizeBytes
    : null;
  const sha256 = typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/iu.test(value.sha256.trim())
    ? value.sha256.trim().toLowerCase()
    : null;
  if (!executionTarget.success || !owner.success || !mediaKind.success || !mimeType.success || !name.success || !sizeBytes || !sha256) {
    return null;
  }
  const expectedImage = mediaKind.data === 'image';
  if (expectedImage !== mimeType.data.startsWith('image/')) return null;
  return {
    executionTarget: executionTarget.data,
    owner: owner.data,
    mediaKind: mediaKind.data,
    mimeType: mimeType.data,
    name: name.data,
    sizeBytes,
    sha256,
  };
}

export function resolveComposerMediaStageUploadTarget(input: Readonly<{
  request: ComposerMediaStageUploadInitRequest;
  deps: ComposerMediaStageUploadTargetDeps;
  sessionRpcTransferMaxBytes?: number | null;
}>): ResolveComposerMediaStageUploadTargetResult {
  const request = readRequest(input.request);
  if (!request) return { success: false, error: 'Invalid Composer media stage request' };
  if (!sameExecutionTarget(request.executionTarget, input.deps.executionTarget)) {
    return { success: false, error: 'Composer media stage target does not match target daemon' };
  }
  if (isServerRoutedTransferOverSizeLimit(request.sizeBytes, input.sessionRpcTransferMaxBytes ?? null)) {
    return { success: false, error: SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR };
  }
  if (request.sizeBytes > configuration.filesUploadMaxFileBytes) {
    return { success: false, error: 'File exceeds upload size limit' };
  }

  return {
    success: true,
    sha256Expected: request.sha256,
    target: {
      destPath: 'composer-media-stage',
      destDisplayPath: 'Composer media stage',
      expectedSizeBytes: request.sizeBytes,
      overwrite: false,
      finalizeUpload: async ({ tempPath, sizeBytes, sha256 }) => {
        const finalized = await input.deps.store.finalizeUpload({
          tempPath,
          sizeBytes,
          sha256,
          executionTarget: request.executionTarget,
          owner: request.owner,
          mediaKind: request.mediaKind,
          mimeType: request.mimeType,
          name: request.name,
        });
        if (!finalized.success) {
          return { success: false, error: finalized.error };
        }
        return {
          success: true,
          path: 'Composer media stage',
          sizeBytes: finalized.handle.sizeBytes,
          result: finalized.handle,
        };
      },
    },
  };
}
