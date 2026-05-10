import { parsePermissionIntentAlias } from '../../../permissions/index.js';
import type { PermissionIntent } from '../../../types.js';

type PermissionModeInferenceMessage = Readonly<{
  kind?: unknown;
  createdAt?: unknown;
  meta?: Readonly<{
    permissionMode?: unknown;
  }> | null;
}>;

export type InferredPermissionModeIntent = Readonly<{
  permissionMode: PermissionIntent;
  updatedAt: number;
}>;

export function inferLatestUserPermissionModeIntent(
  messages: ReadonlyArray<PermissionModeInferenceMessage>,
): InferredPermissionModeIntent | null {
  let best: InferredPermissionModeIntent | null = null;

  for (const message of messages) {
    if (message.kind !== 'user-text') continue;
    const rawMode = message.meta?.permissionMode;
    const parsed = typeof rawMode === 'string' ? parsePermissionIntentAlias(rawMode) : null;
    if (!parsed) continue;

    const createdAt = message.createdAt;
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) continue;

    if (!best || createdAt > best.updatedAt) {
      best = { permissionMode: parsed, updatedAt: createdAt };
    }
  }

  return best;
}
