import {
  ComposerContentHandleV1Schema,
  ComposerContentInspectRequestV1Schema,
  type ComposerContentHandleV1,
} from '@happier-dev/protocol';

import {
  isServerRoutedTransferOverSizeLimit,
  SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR,
} from '@/transfers/policy/serverRoutedTransferPolicy';
import type { ComposerMediaStageStore } from '@/transfers/staging/composerMediaStageStore';

import type { DownloadTransferSource } from './downloadTransferSource';

export type ComposerMediaStageDownloadInitRequest = Readonly<{
  t: 'composer_media_stage_inspect_v1';
  handle: unknown;
  offset: unknown;
  maxBytes: unknown;
  recipientPublicKeyBase64: unknown;
}>;

type ParsedComposerMediaStageDownloadRequest = Readonly<{
  handle: ComposerContentHandleV1;
  offset: number;
  maxBytes: number;
}>;

export type ComposerMediaStageDownloadSourceDeps = Readonly<{
  store: ComposerMediaStageStore;
}>;

export type ResolveComposerMediaStageDownloadSourceResult =
  | Readonly<{ success: true; source: DownloadTransferSource }>
  | Readonly<{ success: false; error: string }>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function readRequest(value: ComposerMediaStageDownloadInitRequest): ParsedComposerMediaStageDownloadRequest | null {
  if (!isRecord(value) || !hasExactKeys(value, [
    't',
    'handle',
    'offset',
    'maxBytes',
    'recipientPublicKeyBase64',
  ]) || value.t !== 'composer_media_stage_inspect_v1') {
    return null;
  }
  const handle = ComposerContentHandleV1Schema.safeParse(value.handle);
  const inspection = ComposerContentInspectRequestV1Schema.safeParse({
    offset: value.offset,
    maxBytes: value.maxBytes,
  });
  if (!handle.success || !inspection.success) return null;
  return {
    handle: handle.data,
    offset: inspection.data.offset,
    maxBytes: inspection.data.maxBytes,
  };
}

/**
 * Resolves one bounded opaque-content inspection to the incumbent download
 * lifecycle. The private stage path stays inside the transfer owner; the
 * caller receives only encrypted download chunks.
 */
export async function resolveComposerMediaStageDownloadSource(input: Readonly<{
  request: ComposerMediaStageDownloadInitRequest;
  deps: ComposerMediaStageDownloadSourceDeps;
  sessionRpcTransferMaxBytes?: number | null;
}>): Promise<ResolveComposerMediaStageDownloadSourceResult> {
  const request = readRequest(input.request);
  if (!request) return { success: false, error: 'Invalid Composer media inspection request' };

  const inspected = await input.deps.store.inspectForFinalization({
    handle: request.handle,
    executionTarget: request.handle.executionTarget,
    owner: request.handle.owner,
  });
  if (inspected.status !== 'ready') {
    return { success: false, error: 'Composer media stage is unavailable' };
  }

  const sizeBytes = Math.min(request.maxBytes, Math.max(0, inspected.sizeBytes - request.offset));
  if (isServerRoutedTransferOverSizeLimit(sizeBytes, input.sessionRpcTransferMaxBytes ?? null)) {
    return { success: false, error: SERVER_ROUTED_FILE_TRANSFER_SIZE_LIMIT_ERROR };
  }

  return {
    success: true,
    source: {
      filePath: inspected.filePath,
      deleteFileOnClose: false,
      sourceOffsetBytes: request.offset,
      sizeBytes,
      name: inspected.name,
    },
  };
}
