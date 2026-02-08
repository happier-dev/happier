import type { Metadata, UserMessage } from '@/api/types';

import { resolveMetadataStringOverrideV1 } from '@happier-dev/agents';

export function resolveModelOverridePrecedence(opts: {
  metadata: Metadata | null | undefined;
  latestUserMessage: (UserMessage & { createdAt?: number }) | null | undefined;
}): { modelId: string | null; updatedAt: number } | null {
  const msg = opts.latestUserMessage;
  const createdAt = typeof msg?.createdAt === 'number' && Number.isFinite(msg.createdAt) ? msg.createdAt : 0;

  // Message meta is turn-scoped; if explicitly provided, it always wins for that turn,
  // even if newer session metadata exists.
  if (msg && msg.meta && Object.prototype.hasOwnProperty.call(msg.meta, 'model')) {
    const raw = (msg.meta as any).model as unknown;
    if (raw === null) {
      return { modelId: null, updatedAt: createdAt };
    }

    if (typeof raw === 'string') {
      const normalized = raw.trim();
      if (!normalized || normalized === 'default') {
        return { modelId: null, updatedAt: createdAt };
      }
      return { modelId: normalized, updatedAt: createdAt };
    }

    return { modelId: null, updatedAt: createdAt };
  }

  const resolved = resolveMetadataStringOverrideV1(opts.metadata ?? null, 'modelOverrideV1', 'modelId');
  if (!resolved) return null;
  if (resolved.value === 'default') return null;

  return { modelId: resolved.value, updatedAt: resolved.updatedAt };
}

