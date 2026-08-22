import {
  ComposerContentHandleV1Schema,
  type ComposerContentHandleV1,
  type ComposerContentMediaKindV1,
  type ComposerContentMimeTypeV1,
  type PluginContributionIdentityV1,
  type SessionExecutionTargetV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { RpcHandlerInvoker } from '@/api/rpc/types';
import { createEncryptedTransferChunkEnvelope } from '@/machines/transfer/transferChunkEncryption';

export type ComposerMediaStageUploadCarrierResult =
  | Readonly<{ success: true; handle: ComposerContentHandleV1 }>
  | Readonly<{
      success: false;
      code: 'aborted' | 'transfer_failed' | 'invalid_response';
    }>;

type ComposerMediaStageUploadInitSuccess = Readonly<{
  uploadId: string;
  chunkSizeBytes: number;
  recipientPublicKeyBase64: string;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readInitSuccess(value: unknown): ComposerMediaStageUploadInitSuccess | null {
  if (!isRecord(value) || value.success !== true) return null;
  const uploadId = typeof value.uploadId === 'string' ? value.uploadId.trim() : '';
  const chunkSizeBytes = value.chunkSizeBytes;
  const recipientPublicKeyBase64 = typeof value.recipientPublicKeyBase64 === 'string'
    ? value.recipientPublicKeyBase64.trim()
    : '';
  if (
    !uploadId
    || typeof chunkSizeBytes !== 'number'
    || !Number.isSafeInteger(chunkSizeBytes)
    || chunkSizeBytes <= 0
    || !recipientPublicKeyBase64
  ) {
    return null;
  }
  return { uploadId, chunkSizeBytes, recipientPublicKeyBase64 };
}

function isTransferSuccess(value: unknown): boolean {
  return isRecord(value) && value.success === true;
}

function sameExecutionTarget(
  left: SessionExecutionTargetV1,
  right: SessionExecutionTargetV1,
): boolean {
  return left.serverId === right.serverId && left.machineId === right.machineId;
}

function sameOwner(
  left: PluginContributionIdentityV1,
  right: PluginContributionIdentityV1,
): boolean {
  return left.pluginId === right.pluginId && left.localId === right.localId;
}

function readFinalizedHandle(input: Readonly<{
  response: unknown;
  executionTarget: SessionExecutionTargetV1;
  owner: PluginContributionIdentityV1;
  mediaKind: ComposerContentMediaKindV1;
  mimeType: ComposerContentMimeTypeV1;
  name: string;
  sizeBytes: number;
  sha256: string;
}>): ComposerContentHandleV1 | null {
  if (!isRecord(input.response) || input.response.success !== true) return null;
  const parsed = ComposerContentHandleV1Schema.safeParse(input.response.result);
  if (!parsed.success) return null;
  const handle = parsed.data;
  if (
    !sameExecutionTarget(handle.executionTarget, input.executionTarget)
    || !sameOwner(handle.owner, input.owner)
    || handle.mediaKind !== input.mediaKind
    || handle.mimeType !== input.mimeType
    || handle.name !== input.name
    || handle.sizeBytes !== input.sizeBytes
    || handle.sha256 !== input.sha256
  ) {
    return null;
  }
  return handle;
}

/**
 * A daemon-local caller for the existing transfer upload lifecycle. It owns no
 * transfer state, temp files, or finalization: the registered target handler
 * owns all three and routes `composer_media_stage_upload_v1` to the one stage
 * store finalizer.
 */
export async function uploadComposerMediaStageViaLocalRpc(input: Readonly<{
  rpc: RpcHandlerInvoker;
  bytes: Uint8Array;
  executionTarget: SessionExecutionTargetV1;
  owner: PluginContributionIdentityV1;
  mediaKind: ComposerContentMediaKindV1;
  mimeType: ComposerContentMimeTypeV1;
  name: string;
  sha256: string;
  signal?: AbortSignal;
}>): Promise<ComposerMediaStageUploadCarrierResult> {
  if (input.signal?.aborted) return { success: false, code: 'aborted' };

  let uploadId: string | null = null;
  try {
    const init = await input.rpc.invokeLocal(
      RPC_METHODS.DAEMON_TRANSFER_UPLOAD_INIT,
      {
        t: 'composer_media_stage_upload_v1',
        executionTarget: input.executionTarget,
        owner: input.owner,
        mediaKind: input.mediaKind,
        mimeType: input.mimeType,
        name: input.name,
        sizeBytes: input.bytes.byteLength,
        sha256: input.sha256,
      },
      input.signal ? { signal: input.signal } : undefined,
    );
    if (input.signal?.aborted) return { success: false, code: 'aborted' };
    const initialized = readInitSuccess(init);
    if (!initialized) return { success: false, code: 'transfer_failed' };
    uploadId = initialized.uploadId;

    for (let index = 0, offset = 0; offset < input.bytes.byteLength; index += 1) {
      if (input.signal?.aborted) return { success: false, code: 'aborted' };
      const chunkLength = Math.min(initialized.chunkSizeBytes, input.bytes.byteLength - offset);
      const payload = Buffer.from(input.bytes.subarray(offset, offset + chunkLength));
      const encrypted = createEncryptedTransferChunkEnvelope({
        transferId: uploadId,
        sequence: index,
        payload,
        recipientPublicKeyBase64: initialized.recipientPublicKeyBase64,
      });
      const wroteChunk = await input.rpc.invokeLocal(
        RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK,
        {
          uploadId,
          index,
          payloadBase64: encrypted.payloadBase64,
          encryptedDataKeyEnvelopeBase64: encrypted.encryptedDataKeyEnvelopeBase64,
        },
        input.signal ? { signal: input.signal } : undefined,
      );
      if (input.signal?.aborted) return { success: false, code: 'aborted' };
      if (!isTransferSuccess(wroteChunk)) return { success: false, code: 'transfer_failed' };
      offset += chunkLength;
    }

    if (input.signal?.aborted) return { success: false, code: 'aborted' };
    const finalized = await input.rpc.invokeLocal(
      RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE,
      { uploadId },
      input.signal ? { signal: input.signal } : undefined,
    );
    if (input.signal?.aborted) return { success: false, code: 'aborted' };
    const handle = readFinalizedHandle({
      response: finalized,
      executionTarget: input.executionTarget,
      owner: input.owner,
      mediaKind: input.mediaKind,
      mimeType: input.mimeType,
      name: input.name,
      sizeBytes: input.bytes.byteLength,
      sha256: input.sha256,
    });
    if (!handle) return { success: false, code: isTransferSuccess(finalized) ? 'invalid_response' : 'transfer_failed' };
    uploadId = null;
    return { success: true, handle };
  } catch {
    return { success: false, code: input.signal?.aborted ? 'aborted' : 'transfer_failed' };
  } finally {
    if (uploadId) {
      await input.rpc.invokeLocal(
        RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT,
        { uploadId },
      ).catch(() => undefined);
    }
  }
}

/** Best-effort cleanup after a caller loses generation/target currentness. */
export async function releaseComposerMediaStageViaLocalRpc(input: Readonly<{
  rpc: RpcHandlerInvoker;
  handle: ComposerContentHandleV1;
}>): Promise<void> {
  await input.rpc.invokeLocal(
    RPC_METHODS.DAEMON_TRANSFER_COMPOSER_MEDIA_RELEASE,
    { handle: input.handle },
  ).catch(() => undefined);
}
