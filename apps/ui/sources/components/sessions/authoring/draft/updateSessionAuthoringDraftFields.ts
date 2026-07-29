import type { ModelMode, PermissionMode } from '@/sync/domains/permissions/permissionTypes';
import { SessionModelSelectionV1Schema } from '@happier-dev/protocol';
import { resolveBackendTargetKeyV2 } from '@/agents/backendCatalog/backendTargetKeyV2';

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
    const backendTarget = draft.backendTarget
        ?? (draft.agentId ? { kind: 'backend' as const, backendId: draft.agentId } : null);
    if (!backendTarget) {
        throw new Error('Session authoring model selection requires backend target');
    }
    const agentTargetKey = resolveBackendTargetKeyV2(backendTarget);
    if (
        draft.modelSelection?.ref.agentTargetKey === agentTargetKey
        && draft.modelSelection.ref.modelId === modelMode
    ) {
        return draft;
    }
    return {
        ...draft,
        modelSelection: SessionModelSelectionV1Schema.parse({
            v: 1,
            updatedAt,
            ref: {
                agentTargetKey,
                providerConnectionId: null,
                modelId: modelMode,
            },
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
