import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { SessionModelSelectionV1Schema, type SessionModelSelectionV1 } from '@happier-dev/protocol/providers/model-selection';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';

/**
 * The one way an authored model choice becomes a durable selection.
 *
 * A model id alone is not a selection: it only means something bound to the
 * Agent target it was chosen for. Both the Session draft writer and the shared
 * authoring controls build the value here so a workflow step and an ordinary
 * Session cannot bind the same model to different target keys.
 */

/** `null` when the choice is the Agent's own default, i.e. no explicit selection. */
export function buildSessionModelSelectionForAgentTarget(params: Readonly<{
    agentTarget: AgentExecutionTargetV1 | null | undefined;
    modelId: string;
    updatedAt: number;
}>): SessionModelSelectionV1 | null {
    if (params.modelId === 'default') return null;
    if (!params.agentTarget) return null;
    return SessionModelSelectionV1Schema.parse({
        v: 1,
        updatedAt: params.updatedAt,
        ref: {
            agentTargetKey: buildBackendTargetKeyV2(params.agentTarget),
            providerConnectionId: null,
            modelId: params.modelId,
        },
    });
}

/** The model-option id a selection corresponds to; `default` when unset. */
export function readSessionModelSelectionOptionId(
    selection: SessionModelSelectionV1 | null | undefined,
): string {
    return selection?.ref.modelId ?? 'default';
}
