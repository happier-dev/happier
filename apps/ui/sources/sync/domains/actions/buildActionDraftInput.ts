import {
  AgentExecutionTargetV1Schema,
  buildActionDraftSeedInput,
  buildQualifiedPluginContributionKey,
  convertBackendTargetRefV2ToV1,
  getActionSpec,
  readBackendTargetRefV2,
  type ActionId,
  type BackendTargetRefV1,
  type BackendTargetRefV2Input,
} from '@happier-dev/protocol';

import { resolveBundledAgentIdFromContributionIdentity } from '@/agents/catalog/catalog';

function convertDefaultBackendTargetToLegacyActionTarget(
  input: BackendTargetRefV2Input,
): BackendTargetRefV1 {
  const canonicalAgentTarget = AgentExecutionTargetV1Schema.safeParse(input);
  if (canonicalAgentTarget.success) {
    const agentId = resolveBundledAgentIdFromContributionIdentity(canonicalAgentTarget.data.identity)
      ?? buildQualifiedPluginContributionKey(canonicalAgentTarget.data.identity);
    return { kind: 'builtInAgent', agentId };
  }

  return convertBackendTargetRefV2ToV1(readBackendTargetRefV2(input));
}

export function buildActionDraftInput(args: Readonly<{
  actionId: ActionId;
  sessionId?: string | null;
  defaultBackendTarget?: BackendTargetRefV2Input | null;
  defaultBackendId?: string | null;
  instructions?: string | null;
  extra?: Record<string, unknown> | null;
}>): Record<string, unknown> {
  const spec = getActionSpec(args.actionId as any);
  const defaultBackendTargetV1 = args.defaultBackendTarget
    ? convertDefaultBackendTargetToLegacyActionTarget(args.defaultBackendTarget)
    : null;
  const seed = buildActionDraftSeedInput(spec as any, {
    defaultBackendTarget: defaultBackendTargetV1,
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
