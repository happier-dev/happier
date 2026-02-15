import type { ActionId } from '@happier-dev/protocol';
import { ActionIdSchema } from '@happier-dev/protocol';

export function readDisabledActionIdsFromEnv(): readonly ActionId[] {
  const raw = typeof process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS === 'string'
    ? process.env.HAPPIER_ACTIONS_DISABLED_ACTION_IDS.trim()
    : '';
  if (!raw) return [];

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: ActionId[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    const result = ActionIdSchema.safeParse(item);
    if (!result.success) continue;
    const id = result.data;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function isActionEnabledByEnv(actionId: ActionId): boolean {
  const disabled = readDisabledActionIdsFromEnv();
  return !disabled.includes(actionId);
}

