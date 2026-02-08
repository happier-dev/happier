import type { Metadata } from '@/api/types';

import { resolveModelOverrideFromMetadataSnapshot } from '@/agent/runtime/permissionModeFromMetadata';

export function adoptModelOverrideFromMetadata(opts: Readonly<{
  currentModelId: string | undefined;
  currentUpdatedAt: number;
  metadata: Metadata | null | undefined;
}>): { modelId: string | undefined; updatedAt: number; didChange: boolean } {
  const resolved = resolveModelOverrideFromMetadataSnapshot({ metadata: opts.metadata });
  if (!resolved) {
    return { modelId: opts.currentModelId, updatedAt: opts.currentUpdatedAt, didChange: false };
  }
  if (resolved.updatedAt <= opts.currentUpdatedAt) {
    return { modelId: opts.currentModelId, updatedAt: opts.currentUpdatedAt, didChange: false };
  }
  return { modelId: resolved.modelId, updatedAt: resolved.updatedAt, didChange: true };
}

