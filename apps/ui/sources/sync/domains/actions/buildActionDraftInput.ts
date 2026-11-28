import {
  type BackendTargetRefV2Input,
} from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { buildActionDraftSeedInput } from '@happier-dev/protocol/actions/actionDraftSeed';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindContextualActionToolInput, type SessionBoundActionToolContext } from '@happier-dev/protocol/actions/actionToolContext';

export function buildActionDraftInput(args: Readonly<{
  actionId: ActionId;
  sessionId?: string | null;
  defaultBackendTarget?: BackendTargetRefV2Input | null;
  defaultBackendId?: string | null;
  instructions?: string | null;
  extra?: Record<string, unknown> | null;
  context?: SessionBoundActionToolContext;
}>): Record<string, unknown> {
  const spec = getActionSpec(args.actionId as any);
  const seed = buildActionDraftSeedInput(spec as any, {
    defaultBackendTarget: args.defaultBackendTarget,
    defaultBackendId: args.defaultBackendId ?? null,
    instructions: args.instructions ?? null,
  });

  const sessionId = typeof args.sessionId === 'string' && args.sessionId.trim().length > 0 ? args.sessionId.trim() : null;
  const extra = args.extra && typeof args.extra === 'object' ? args.extra : null;

  const input = {
    ...(sessionId ? { sessionId } : null),
    ...seed,
    ...(extra ?? null),
  };
  return args.context ? bindContextualActionToolInput({
    actionId: args.actionId, input, context: args.context,
  }) as Record<string, unknown> : input;
}
