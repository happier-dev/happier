import { readFile } from 'node:fs/promises';

import {
  PromptAssetMutationResponseV1Schema,
  PromptAssetWriteRequestSchema,
  type PromptAssetMutationResponseV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import type { PromptAssetAdapter } from '@happier-dev/plugin-sdk/resources';

import type { UploadTransferTarget } from './uploadTransferTarget';
import { writePromptAsset } from '@/prompts/assets/actions';

export type PromptAssetUploadTarget = UploadTransferTarget<PromptAssetMutationResponseV1> & Readonly<{
  destPath: string;
}>;

type PromptAssetUploadTargetResult =
  | Readonly<{ success: true; target: PromptAssetUploadTarget }>
  | Readonly<{ success: false; error: string }>;

function invalidPromptAssetWriteResponse(error: string): PromptAssetMutationResponseV1 {
  return PromptAssetMutationResponseV1Schema.parse({
    ok: false,
    errorCode: 'invalid_request',
    error,
  });
}

function internalPromptAssetWriteResponse(error: string): PromptAssetMutationResponseV1 {
  return PromptAssetMutationResponseV1Schema.parse({
    ok: false,
    errorCode: 'internal_error',
    error,
  });
}

export function resolvePromptAssetUploadTarget(input: Readonly<{
  adapterRegistry: ReadonlyMap<string, PromptAssetAdapter>;
  sizeBytes: unknown;
}>): PromptAssetUploadTargetResult {
  const rawSize = typeof input.sizeBytes === 'number' ? input.sizeBytes : Number(input.sizeBytes);
  if (!Number.isFinite(rawSize)) {
    return { success: false, error: 'Invalid sizeBytes' };
  }

  const sizeBytes = Math.floor(rawSize);
  if (sizeBytes < 0) {
    return { success: false, error: 'Invalid sizeBytes' };
  }
  if (sizeBytes > configuration.promptTransferJsonMaxBytes) {
    return { success: false, error: 'Prompt transfer payload exceeds size limit' };
  }

  return {
    success: true,
    target: {
      destPath: 'prompt-asset-upload.json',
      destDisplayPath: 'prompt-asset-upload.json',
      expectedSizeBytes: sizeBytes,
      overwrite: true,
      finalizeUpload: async ({ tempPath, sizeBytes: finalizedSizeBytes }) => {
        let requestBodyText: string;
        try {
          requestBodyText = await readFile(tempPath, 'utf8');
        } catch (error) {
          return {
            success: true,
            path: 'prompt-asset-upload.json',
            sizeBytes: finalizedSizeBytes,
            result: internalPromptAssetWriteResponse(
              error instanceof Error ? error.message : 'failed to read prompt asset upload payload',
            ),
          };
        }

        let requestJson: unknown;
        try {
          requestJson = JSON.parse(requestBodyText);
        } catch {
          return {
            success: true,
            path: 'prompt-asset-upload.json',
            sizeBytes: finalizedSizeBytes,
            result: invalidPromptAssetWriteResponse('invalid_request'),
          };
        }

        const parsed = PromptAssetWriteRequestSchema.safeParse(requestJson);
        if (!parsed.success) {
          return {
            success: true,
            path: 'prompt-asset-upload.json',
            sizeBytes: finalizedSizeBytes,
            result: invalidPromptAssetWriteResponse('invalid_request'),
          };
        }

        try {
          const result = await writePromptAsset({
            registry: input.adapterRegistry,
            request: parsed.data,
          });

          return {
            success: true,
            path: 'prompt-asset-upload.json',
            sizeBytes: finalizedSizeBytes,
            result,
          };
        } catch (error) {
          return {
            success: true,
            path: 'prompt-asset-upload.json',
            sizeBytes: finalizedSizeBytes,
            result: internalPromptAssetWriteResponse(
              error instanceof Error ? error.message : 'failed to write prompt asset',
            ),
          };
        }
      },
    },
  };
}
