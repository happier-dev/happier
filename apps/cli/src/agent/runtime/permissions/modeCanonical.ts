import type { PermissionMode } from '@/api/types';
import { isPermissionMode } from '@/api/types';
import { parsePermissionIntentAlias } from '@happier-dev/agents';

export function normalizePermissionModeToIntent(raw: unknown): PermissionMode | null {
  if (typeof raw !== 'string') return null;
  const parsed = parsePermissionIntentAlias(raw);
  if (!parsed) return null;
  // Defensive: keep CLI's PermissionMode as the runtime gate until the wire schema is narrowed.
  return isPermissionMode(parsed) ? parsed : null;
}

export function resolvePermissionModeUpdatedAtFromMessage(
  message: { createdAt?: unknown } | null | undefined,
  nowMs: () => number = Date.now,
): number {
  const createdAt = message?.createdAt;
  if (typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0) {
    return createdAt;
  }
  return nowMs();
}

