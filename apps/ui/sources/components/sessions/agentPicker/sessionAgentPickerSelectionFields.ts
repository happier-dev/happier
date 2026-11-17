import { buildAcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';
import type { AgentExecutionTargetV1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import type { AcpConfigOptionOverridesV1 } from '@happier-dev/protocol/sessions/metadata/overrides';

import { buildSessionModelSelectionForAgentTarget } from '@/components/sessions/authoring/sessionModelSelectionValue';

import type { SessionAgentPickerSelection } from './buildSessionAgentPickerDetailContent';

export type SessionAgentPickerSelectionFields = Readonly<{
    modelSelection: SessionModelSelection | null;
    acpSessionModeId: string | null;
    sessionConfigOptionOverrides: AcpConfigOptionOverridesV1 | null;
}>;

/**
 * The one writer from an Agent picker's engine selection (model, mode, string options) to the authored
 * fields every host stores. A structured model selection counts only for the Agent and model chosen;
 * the Agent's own default is no selection. The pane edits string options; typed overrides it cannot
 * show (`retainedOverrides`, the same Agent's current ones) stay authored.
 */
export function resolveSessionAgentPickerSelectionFields(params: Readonly<{
    /** The chosen Agent target, or its key. */
    agentTarget: AgentExecutionTargetV1 | string;
    selection: SessionAgentPickerSelection;
    updatedAt: number;
    retainedOverrides?: AcpConfigOptionOverridesV1 | null;
}>): SessionAgentPickerSelectionFields {
    const { selection, updatedAt } = params;
    const targetKey = typeof params.agentTarget === 'string' ? params.agentTarget : buildBackendTargetKeyV2(params.agentTarget);
    const structured = selection.modelSelection?.ref.agentTargetKey === targetKey && selection.modelSelection.ref.modelId === selection.modelId
        ? selection.modelSelection : null;
    const modelSelection = structured && !(selection.modelId === 'default' && (structured.v === 2 ? structured.ref.source === 'native' : structured.ref.providerConnectionId === null))
        ? structured
        : buildSessionModelSelectionForAgentTarget({ agentTarget: params.agentTarget, modelId: selection.modelId, updatedAt });
    const overrides = {
        ...Object.fromEntries(Object.entries(params.retainedOverrides?.overrides ?? {}).filter(([, override]) => typeof override.value !== 'string')),
        ...Object.fromEntries(Object.entries(selection.configOverrides ?? {}).flatMap(([id, value]) => {
            const trimmed = typeof value === 'string' ? value.trim() : '';
            return trimmed ? [[id, { value: trimmed, updatedAt }] as const] : [];
        })),
    };
    return {
        modelSelection,
        // The pane's blank mode means none chosen: the Agent supplies its own default, as in New Session.
        acpSessionModeId: readNonBlankOpaqueIdentifier(selection.sessionModeId),
        sessionConfigOptionOverrides: Object.keys(overrides).length === 0 ? null : buildAcpConfigOptionOverridesV1({ updatedAt, overrides }),
    };
}
