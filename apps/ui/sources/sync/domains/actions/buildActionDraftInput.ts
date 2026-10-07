import {
  type BackendTargetRefV2Input,
} from '@happier-dev/protocol';
import type { ActionId } from '@happier-dev/protocol';
import { buildActionDraftSeedInput } from '@happier-dev/protocol/actions/actionDraftSeed';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';

export function buildActionDraftInput(args: Readonly<{
  actionId: ActionId;
  sessionId?: string | null;
  defaultBackendTarget?: BackendTargetRefV2Input | null;
  defaultBackendId?: string | null;
  instructions?: string | null;
  extra?: Record<string, unknown> | null;
}>): Record<string, unknown> {
  const spec = getActionSpec(args.actionId as any);
  const seed = buildActionDraftSeedInput(spec as any, {
    defaultBackendTarget: args.defaultBackendTarget,
    defaultBackendId: args.defaultBackendId ?? null,
    instructions: args.instructions ?? null,
  });

  const sessionId = typeof args.sessionId === 'string' && args.sessionId.trim().length > 0 ? args.sessionId.trim() : null;
  const extra = args.extra && typeof args.extra === 'object' ? args.extra : null;

  return {
    ...(sessionId ? { sessionId } : null),
    ...seed,
    ...(extra ?? null),
  };
}
