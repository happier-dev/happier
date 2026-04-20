import type {
  PromptAssetMutationErrorCodeV1,
  PromptAssetMutationResponseV1,
  PromptAssetReadResponseV1,
} from '@happier-dev/protocol';

export type PromptAssetMutationErrorResponseV1 = Extract<PromptAssetMutationResponseV1, { ok: false }>;
export type PromptAssetReadErrorResponseV1 = Extract<PromptAssetReadResponseV1, { ok: false }>;

export function toPromptAssetReadError(
  errorCode: PromptAssetMutationErrorCodeV1,
  error: string,
): PromptAssetReadErrorResponseV1 {
  return { ok: false, errorCode, error };
}

export function toPromptAssetMutationError(
  errorCode: PromptAssetMutationErrorCodeV1,
  error: string,
  currentDigest?: string | null,
): PromptAssetMutationErrorResponseV1 {
  return {
    ok: false,
    errorCode,
    error,
    ...(currentDigest !== undefined ? { currentDigest } : {}),
  };
}
