import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { buildBackendTargetKeyV2, parseBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ConnectedServiceBindingsV2Schema } from '@happier-dev/protocol/connect/connectedServiceBindings';
import {
    isLlmTaskRunnerAutoV1,
    LlmTaskRunnerConfigV1WriteSchema,
    type LlmTaskPermissionMode,
    type LlmTaskRunnerChoiceV1,
    type LlmTaskRunnerConfigV1,
} from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import type { WorkflowSessionAuthoringSelection } from '@happier-dev/protocol/workflows/workflowV1';

import type { SessionAuthoringControlFacts } from '@/components/sessions/authoring/controls/sessionAuthoringFieldControls';

const EMPTY_SELECTION: WorkflowSessionAuthoringSelection = Object.freeze({});

function readAgentTarget(agentTargetKey: string, facts: SessionAuthoringControlFacts | undefined) {
    const offered = facts?.agentTargets?.find(option => buildBackendTargetKeyV2(option.target) === agentTargetKey);
    if (offered) return offered.target;
    try {
        const parsed = AgentExecutionTargetV1Schema.safeParse(parseBackendTargetKeyV2(agentTargetKey));
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
}

/** A runner choice as the shared engine controls read it. Auto has no engine of its own. */
export function projectLlmTaskRunnerAuthoringSelection(
    choice: LlmTaskRunnerChoiceV1 | null | undefined,
    facts: SessionAuthoringControlFacts | undefined,
): WorkflowSessionAuthoringSelection {
    if (isLlmTaskRunnerAutoV1(choice)) return EMPTY_SELECTION;
    const ref = choice.modelSelection;
    const agentTarget = readAgentTarget(ref.agentTargetKey, facts);
    return {
        ...(agentTarget ? { agentTarget } : {}),
        // The Agent's own default is no explicit model selection.
        modelSelection: ref.modelId === 'default' && ref.providerConnectionId === null ? null : { v: 1, ref, updatedAt: 0 },
        ...(choice.connectedServices !== undefined ? { connectedServices: choice.connectedServices } : {}),
        ...(choice.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: choice.sessionConfigOptionOverrides } : {}),
    };
}

/** The engine the shared controls authored, as one explicit runner. Null until an Agent is chosen. */
export function readLlmTaskRunnerFromAuthoringSelection(
    selection: WorkflowSessionAuthoringSelection,
    permissionMode: LlmTaskPermissionMode,
): LlmTaskRunnerConfigV1 | null {
    if (!selection.agentTarget) return null;
    const agentTargetKey = buildBackendTargetKeyV2(selection.agentTarget);
    const ref = selection.modelSelection?.ref.agentTargetKey === agentTargetKey ? selection.modelSelection.ref : null;
    const connectedServices = selection.connectedServices === undefined ? undefined
        : selection.connectedServices === null ? null : ConnectedServiceBindingsV2Schema.safeParse(selection.connectedServices).data;
    return LlmTaskRunnerConfigV1WriteSchema.parse({
        v: 1,
        modelSelection: ref ?? { agentTargetKey, providerConnectionId: null, modelId: 'default' },
        ...(connectedServices !== undefined ? { connectedServices } : {}),
        ...(selection.sessionConfigOptionOverrides ? { sessionConfigOptionOverrides: selection.sessionConfigOptionOverrides } : {}),
        permissionMode,
    });
}
