import { VOICE_MODEL_PACK_CONTRIBUTION_MAX_FILES_V1 } from '@happier-dev/protocol';

export type VoiceModelPackResourcePolicyV1 = Readonly<{
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}>;

export const DEFAULT_VOICE_MODEL_PACK_RESOURCE_POLICY_V1: VoiceModelPackResourcePolicyV1 = Object.freeze({
  maxFiles: VOICE_MODEL_PACK_CONTRIBUTION_MAX_FILES_V1,
  maxFileBytes: 4 * 1024 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024 * 1024,
});

export function assertVoiceModelPackDeclaredResourcesV1(
  files: readonly Readonly<{ sizeBytes: number }>[],
  policy: VoiceModelPackResourcePolicyV1 = DEFAULT_VOICE_MODEL_PACK_RESOURCE_POLICY_V1,
): void {
  if (files.length > policy.maxFiles) throw new Error('model_pack_file_count_limit_exceeded');
  if (files.some((file) => file.sizeBytes > policy.maxFileBytes)) {
    throw new Error('model_pack_file_size_limit_exceeded');
  }
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (!Number.isSafeInteger(total) || total > policy.maxTotalBytes) {
    throw new Error('model_pack_total_size_limit_exceeded');
  }
}
