import type { Metadata, PermissionMode, UserMessage } from '@/api/types';
import { isPermissionMode } from '@/api/types';
import { resolveLatestPermissionIntent } from '@happier-dev/agents';

export function resolvePermissionIntentPrecedence(opts: {
  metadata: Metadata | null | undefined;
  latestUserMessage: (UserMessage & { createdAt?: number }) | null | undefined;
}): { intent: PermissionMode; updatedAt: number } | null {
  const metadataCandidate = {
    rawMode: (opts.metadata as any)?.permissionMode,
    updatedAt: (opts.metadata as any)?.permissionModeUpdatedAt,
  };

  const messageCandidate = {
    rawMode: opts.latestUserMessage?.meta?.permissionMode,
    updatedAt: opts.latestUserMessage?.createdAt,
  };

  const resolved = resolveLatestPermissionIntent([messageCandidate, metadataCandidate]);
  if (!resolved) return null;

  // Defensive: keep CLI's PermissionMode enum as the gate until the schema is narrowed.
  if (!isPermissionMode(resolved.intent)) return null;
  return { intent: resolved.intent, updatedAt: resolved.updatedAt };
}

