import type { ModelMode, PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';

import { buildSessionModelSelectionForAgentTarget } from '../sessionModelSelectionValue';
import type { SessionAuthoringDraft } from './sessionAuthoringDraft';

export function updateSessionAuthoringDraftPrompt(
    draft: SessionAuthoringDraft,
    prompt: string,
): SessionAuthoringDraft {
    return {
        ...draft,
        prompt,
        displayText: prompt,
    };
}

export function updateSessionAuthoringDraftPermissionMode(
    draft: SessionAuthoringDraft,
    permissionMode: PermissionMode,
    updatedAt: number,
): SessionAuthoringDraft {
    return {
        ...draft,
        permissionMode,
        permissionModeUpdatedAt: updatedAt,
    };
}

export function updateSessionAuthoringDraftModelMode(
    draft: SessionAuthoringDraft,
    modelMode: ModelMode,
    updatedAt: number,
): SessionAuthoringDraft {
    if (modelMode === 'default') {
        return { ...draft, modelSelection: null };
    }
    if (!draft.agentTarget) {
        throw new Error('Session authoring model selection requires agent target');
    }
    const agentTargetKey = buildBackendTargetKeyV2(draft.agentTarget);
    if (
        draft.modelSelection?.ref.agentTargetKey === agentTargetKey
        && draft.modelSelection.ref.modelId === modelMode
    ) {
        return draft;
    }
    return {
        ...draft,
        modelSelection: buildSessionModelSelectionForAgentTarget({
            agentTarget: draft.agentTarget,
            modelId: modelMode,
            updatedAt,
        }),
    };
}

export function updateSessionAuthoringDraftAutomation(
    draft: SessionAuthoringDraft,
    automation: SessionAuthoringDraft['automation'],
): SessionAuthoringDraft {
    return {
        ...draft,
        automation,
    };
}
